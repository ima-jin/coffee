import { createPublicKey, verify } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateBootstrapKeypair } from '@ima-jin/auth-client';

const mocks = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  getSigningIdentityMock: vi.fn(),
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock('@ima-jin/logger', () => ({ createLogger: () => mocks.log }));
vi.mock('@/lib/signing-identity', () => ({ getSigningIdentity: mocks.getSigningIdentityMock }));

import {
  AppServiceTokenError,
  PAY_SETTLE_SCOPE,
  getAppServiceToken,
  resetAppServiceTokenCache,
} from '../app-service-token';

const APP_DID = 'did:imajin:coffee';
const KERNEL_URL = 'https://kernel.test';
const MINT_URL = `${KERNEL_URL}/auth/api/apps/token/service`;
const SPKI_ED25519_PREFIX = '302a300506032b6570032100';

const keypair = generateBootstrapKeypair();

function mintResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({ token: 'tok_1', expiresIn: 600, scopes: [PAY_SETTLE_SCOPE], ...overrides }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

function mintedBody(callIndex = 0): { appDid: string; nonce: string; timestamp: string; signature: string } {
  return JSON.parse(mocks.fetchMock.mock.calls[callIndex][1].body);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetAppServiceTokenCache();
  vi.stubGlobal('fetch', mocks.fetchMock);
  vi.stubEnv('IMAJIN_KERNEL_URL', `${KERNEL_URL}/`);
  mocks.getSigningIdentityMock.mockReturnValue({ appDid: APP_DID, privateKey: keypair.privateKey, publicKey: keypair.publicKey });
  mocks.fetchMock.mockImplementation(async () => mintResponse());
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('getAppServiceToken — mint', () => {
  it('posts a proof-of-possession to /auth/api/apps/token/service and returns the token', async () => {
    const token = await getAppServiceToken();

    expect(token).toBe('tok_1');
    expect(mocks.fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = mocks.fetchMock.mock.calls[0];
    expect(url).toBe(MINT_URL);
    expect(init.method).toBe('POST');
    const body = mintedBody();
    expect(Object.keys(body).sort()).toEqual(['appDid', 'nonce', 'signature', 'timestamp']);
    expect(body.appDid).toBe(APP_DID);
    expect(body.nonce.length).toBeGreaterThanOrEqual(16);
    expect(Math.abs(Date.now() - Date.parse(body.timestamp))).toBeLessThan(5000);
  });

  it('signs `${appDid}:${nonce}:${timestamp}` with the app key (verifiable with its public key)', async () => {
    await getAppServiceToken();

    const { appDid, nonce, timestamp, signature } = mintedBody();
    const publicKey = createPublicKey({
      key: Buffer.from(SPKI_ED25519_PREFIX + keypair.publicKey, 'hex'),
      format: 'der',
      type: 'spki',
    });
    const valid = verify(null, Buffer.from(`${appDid}:${nonce}:${timestamp}`), publicKey, Buffer.from(signature, 'hex'));
    expect(valid).toBe(true);
  });

  it('never logs or exposes the signature / private key', async () => {
    await getAppServiceToken();

    const logged = JSON.stringify([mocks.log.error.mock.calls, mocks.log.warn.mock.calls, mocks.log.info.mock.calls]);
    expect(logged).not.toContain(keypair.privateKey);
    expect(logged).not.toContain(mintedBody().signature);
  });

  it('warns (without failing) when the minted token lacks pay:settle — operator approval pending', async () => {
    mocks.fetchMock.mockImplementation(async () => mintResponse({ scopes: [] }));

    await expect(getAppServiceToken()).resolves.toBe('tok_1');

    expect(mocks.log.warn).toHaveBeenCalledWith({ appDid: APP_DID }, expect.stringContaining(PAY_SETTLE_SCOPE));
  });

  it('does not warn when the token carries pay:settle', async () => {
    await getAppServiceToken();

    expect(mocks.log.warn).not.toHaveBeenCalled();
  });

  it('throws AppServiceTokenError with the kernel status and message when the mint is refused', async () => {
    mocks.fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: 'App is not active' }), { status: 403 }));

    const failure = await getAppServiceToken().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AppServiceTokenError);
    expect((failure as AppServiceTokenError).status).toBe(403);
    expect((failure as AppServiceTokenError).message).toContain('App is not active');
  });

  it('falls back to the status text when the error body is not JSON', async () => {
    mocks.fetchMock.mockImplementation(async () => new Response('nope', { status: 502, statusText: 'Bad Gateway' }));

    await expect(getAppServiceToken()).rejects.toThrow(/502 Bad Gateway/);
  });

  it('rejects a malformed mint response', async () => {
    mocks.fetchMock.mockImplementation(async () => mintResponse({ token: undefined }));

    await expect(getAppServiceToken()).rejects.toThrow(/malformed mint response/);
  });

  it('propagates the signing-identity error when the app is not claimed yet', async () => {
    mocks.getSigningIdentityMock.mockImplementation(() => {
      throw new Error('signing identity not bootstrapped yet');
    });

    await expect(getAppServiceToken()).rejects.toThrow(/not bootstrapped/);
    expect(mocks.fetchMock).not.toHaveBeenCalled();
  });
});

describe('getAppServiceToken — cache', () => {
  it('reuses the cached token until shortly before it expires, then mints a fresh one', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-08T12:00:00Z'));
    mocks.fetchMock
      .mockImplementationOnce(async () => mintResponse({ token: 'tok_1' }))
      .mockImplementationOnce(async () => mintResponse({ token: 'tok_2' }));

    expect(await getAppServiceToken()).toBe('tok_1');

    vi.advanceTimersByTime(538_000); // 600s TTL - 60s skew = 540s of validity
    expect(await getAppServiceToken()).toBe('tok_1');
    expect(mocks.fetchMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(3_000);
    expect(await getAppServiceToken()).toBe('tok_2');
    expect(mocks.fetchMock).toHaveBeenCalledTimes(2);
  });

  it('shares one mint between concurrent callers', async () => {
    const tokens = await Promise.all([getAppServiceToken(), getAppServiceToken(), getAppServiceToken()]);

    expect(tokens).toEqual(['tok_1', 'tok_1', 'tok_1']);
    expect(mocks.fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failed mint — the next call tries again', async () => {
    mocks.fetchMock
      .mockImplementationOnce(async () => new Response(JSON.stringify({ error: 'boom' }), { status: 500 }))
      .mockImplementationOnce(async () => mintResponse());

    await expect(getAppServiceToken()).rejects.toBeInstanceOf(AppServiceTokenError);
    await expect(getAppServiceToken()).resolves.toBe('tok_1');
  });

  it('resetAppServiceTokenCache forces a remint', async () => {
    await getAppServiceToken();
    resetAppServiceTokenCache();
    await getAppServiceToken();

    expect(mocks.fetchMock).toHaveBeenCalledTimes(2);
  });
});
