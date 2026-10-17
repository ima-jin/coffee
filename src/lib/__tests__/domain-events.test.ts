import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateBootstrapKeypair } from '@ima-jin/auth-client';
import manifest from '../../../imajin.app.json';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  identity: vi.fn(),
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock('@ima-jin/logger', () => ({ createLogger: () => mocks.log }));
vi.mock('@/lib/signing-identity', () => ({ getSigningIdentity: mocks.identity }));

import { publishDomainEvent, type DomainEvent } from '../domain-events';
import { resetAppServiceTokenCache } from '../app-service-token';

const keypair = generateBootstrapKeypair();
const event: DomainEvent = {
  type: 'tip.granted', subject: 'did:imajin:creator', correlationId: 'tip_1',
  payload: { amount: 500, currency: 'USD', context_id: 'tip_1', context_type: 'coffee' },
};
const KERNEL = 'https://kernel.test';

function mintResponse(): Response {
  return Response.json({ token: 'test-service-token', expiresIn: 600, scopes: ['pay:settle'] });
}

beforeEach(() => {
  vi.resetAllMocks();
  resetAppServiceTokenCache();
  vi.stubEnv('IMAJIN_KERNEL_URL', `${KERNEL}/`);
  vi.stubEnv('IMAJIN_APP_DID', 'did:imajin:coffee');
  mocks.identity.mockReturnValue({ ...keypair, appDid: 'did:imajin:coffee' });
  vi.stubGlobal('fetch', mocks.fetch);
  mocks.fetch.mockResolvedValueOnce(mintResponse()).mockResolvedValue(Response.json({ ok: true }, { status: 201 }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('kernel domain events', () => {
  it('declares the explicit event types consumed by the kernel manifest preview', () => {
    expect(manifest.emittableEvents).toEqual(['tip.granted', 'tip.sent']);
  });

  it('mints a keyholder token then posts the public wire shape with bounded, non-redirecting requests', async () => {
    expect(await publishDomainEvent(event)).toBe(true);
    expect(mocks.fetch).toHaveBeenNthCalledWith(1, `${KERNEL}/auth/api/apps/token/service`, expect.objectContaining({
      method: 'POST', signal: expect.any(AbortSignal), redirect: 'error',
    }));
    const proof = JSON.parse(mocks.fetch.mock.calls[0][1].body);
    expect(proof).toMatchObject({ appDid: 'did:imajin:coffee', signature: expect.any(String) });
    expect(mocks.fetch).toHaveBeenNthCalledWith(2, `${KERNEL}/api/events`, expect.objectContaining({
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-service-token' },
      body: JSON.stringify(event), signal: expect.any(AbortSignal), redirect: 'error',
    }));
    expect(mocks.log.info).toHaveBeenCalledWith(
      { type: event.type, correlationId: event.correlationId }, expect.stringContaining('accepted'),
    );
  });

  it('reuses the service token for the sender event', async () => {
    await publishDomainEvent(event);
    await publishDomainEvent({ ...event, type: 'tip.sent', subject: 'did:imajin:sender' });
    expect(mocks.fetch).toHaveBeenCalledTimes(3);
    expect(JSON.parse(mocks.fetch.mock.calls[2][1].body).type).toBe('tip.sent');
  });

  it.each([401, 403, 429, 500])('logs publish status %i without throwing or replaying', async (status) => {
    mocks.fetch.mockReset().mockResolvedValueOnce(mintResponse())
      .mockResolvedValueOnce(Response.json({ error: 'event_type_not_approved', token: 'do-not-log' }, { status }));
    expect(await publishDomainEvent(event)).toBe(false);
    expect(mocks.log.error).toHaveBeenCalledWith(expect.objectContaining({ stage: 'publish', status }), expect.any(String));
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(mocks.log.error.mock.calls)).not.toContain('do-not-log');
  });

  it('invalidates a refused token so the next event remints, without retrying the failed event', async () => {
    mocks.fetch.mockReset().mockResolvedValueOnce(mintResponse())
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(mintResponse())
      .mockResolvedValueOnce(Response.json({ ok: true }));
    await publishDomainEvent(event);
    await publishDomainEvent(event);
    expect(mocks.fetch.mock.calls.map(([url]) => url)).toEqual([
      `${KERNEL}/auth/api/apps/token/service`, `${KERNEL}/api/events`,
      `${KERNEL}/auth/api/apps/token/service`, `${KERNEL}/api/events`,
    ]);
  });

  it.each([401, 403, 429])('logs token-mint status %i and does not publish unauthenticated', async (status) => {
    mocks.fetch.mockReset().mockResolvedValue(Response.json({ error: 'refused' }, { status }));
    expect(await publishDomainEvent(event)).toBe(false);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.log.error).toHaveBeenCalledWith(expect.objectContaining({ stage: 'token', status }), expect.any(String));
  });

  it.each(['IMAJIN_KERNEL_URL', 'IMAJIN_APP_DID'])('names missing %s at error level, never a silent no-op', async (setting) => {
    vi.stubEnv(setting, '');
    expect(await publishDomainEvent(event)).toBe(false);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.log.error).toHaveBeenCalledWith(expect.objectContaining({ setting }), expect.any(String));
  });

  it('names signing-identity recovery settings without exposing arbitrary errors', async () => {
    mocks.identity.mockImplementation(() => { throw new Error('sensitive-test-detail'); });
    expect(await publishDomainEvent(event)).toBe(false);
    expect(mocks.log.error).toHaveBeenCalledWith(expect.objectContaining({ stage: 'token' }), expect.stringContaining('IMAJIN_APP_KEYSTORE'));
    expect(JSON.stringify(mocks.log.error.mock.calls)).not.toContain('sensitive-test-detail');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each(['token', 'publish'])('handles %s network/timeout failures without exposing credentials', async (stage) => {
    mocks.fetch.mockReset();
    if (stage === 'publish') mocks.fetch.mockResolvedValueOnce(mintResponse());
    mocks.fetch.mockRejectedValue(new Error(`private diagnostic ${keypair.privateKey}`));
    expect(await publishDomainEvent(event)).toBe(false);
    expect(mocks.log.error).toHaveBeenCalledWith(expect.objectContaining({ stage }), expect.any(String));
    const logged = JSON.stringify([mocks.log.error.mock.calls, mocks.log.warn.mock.calls, mocks.log.info.mock.calls]);
    expect(logged).not.toContain(keypair.privateKey);
    expect(logged).not.toContain('test-service-token');
  });
});
