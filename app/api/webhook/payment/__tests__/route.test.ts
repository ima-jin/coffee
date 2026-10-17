import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalKernelWebhookPayload } from '@ima-jin/auth/kernel-webhook';

const mocks = vi.hoisted(() => {
  const whereMock = vi.fn().mockResolvedValue(undefined);
  const setMock = vi.fn(() => ({ where: whereMock }));
  return {
    whereMock,
    setMock,
    updateMock: vi.fn(() => ({ set: setMock })),
    findTipMock: vi.fn(),
    settleTipMock: vi.fn(),
    findPageMock: vi.fn(),
    publishMock: vi.fn(),
    log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  };
});

vi.mock('@ima-jin/logger', () => ({ createLogger: () => mocks.log }));
vi.mock('drizzle-orm', () => ({ eq: vi.fn((column: unknown, value: unknown) => ({ column, value })) }));
vi.mock('@/db', () => ({
  db: {
    update: mocks.updateMock,
    query: { tips: { findFirst: mocks.findTipMock }, coffeePages: { findFirst: mocks.findPageMock } },
  },
  tips: { id: 'id-column' },
}));
vi.mock('@/lib/settle', () => ({ settleTip: mocks.settleTipMock }));
vi.mock('@/lib/domain-events', () => ({ publishDomainEvent: mocks.publishMock }));

import { POST } from '../route';

// Only ephemeral test keys: the real published SDK verifies every request.
const signingKey = generateKeyPairSync('ed25519');
const foreignKey = generateKeyPairSync('ed25519');
const publicKey = signingKey.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
const kid = `auth-${createHash('sha256').update(publicKey).digest('hex').slice(0, 16)}`;
const audience = 'did:imajin:coffee-test';
const callbackUrl = 'https://coffee.test/coffee/api/webhook/payment';
const directory = mkdtempSync(join(tmpdir(), 'coffee-kernel-webhook-'));
const discovery = vi.fn();

beforeAll(() => {
  // Exercise the SDK's real file pin store without persisting pins in the checkout.
  vi.spyOn(process, 'cwd').mockReturnValue(directory);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

afterAll(() => {
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

const MANIFEST = {
  chain: [
    { did: 'did:imajin:creator', role: 'creator', amount: 4.93 },
    { did: 'did:imajin:platform', role: 'platform', amount: 0.07 },
  ],
};

const TIP = {
  id: 'tip_1', pageId: 'page_1', fromDid: 'did:imajin:fan', fromName: 'Sam',
  amount: 500, currency: 'USD', payTransactionId: 'tx_1', payeeManifest: MANIFEST, settledAt: null,
};

function makeRequest(body: unknown, options: {
  timestampOffsetSeconds?: number;
  audience?: string;
  privateKey?: typeof signingKey.privateKey;
  url?: string;
  method?: string;
} = {}): Parameters<typeof POST>[0] {
  const rawBody = typeof body === 'string' ? body : JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000) + (options.timestampOffsetSeconds ?? 0));
  const nonce = randomUUID();
  const recipient = options.audience ?? audience;
  const url = options.url ?? callbackUrl;
  const method = options.method ?? 'POST';
  const payload = canonicalKernelWebhookPayload({ audience: recipient, timestamp, nonce, method, url, rawBody });
  const signature = sign(null, Buffer.from(payload), options.privateKey ?? signingKey.privateKey).toString('hex');
  return new Request(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-kernel-audience': recipient,
      'x-kernel-timestamp': timestamp,
      'x-kernel-nonce': nonce,
      'x-kernel-kid': kid,
      'x-kernel-signature': signature,
    },
    body: rawBody,
  }) as Parameters<typeof POST>[0];
}

function changedRequest(request: Request, changes: { body?: string; url?: string; method?: string }): Parameters<typeof POST>[0] {
  return new Request(changes.url ?? request.url, {
    method: changes.method ?? request.method,
    headers: request.headers,
    body: changes.body ?? JSON.stringify({ type: 'payment.succeeded', tipId: 'tip_1' }),
  }) as Parameters<typeof POST>[0];
}

function expectNoSideEffects(): void {
  expect(mocks.updateMock).not.toHaveBeenCalled();
  expect(mocks.findTipMock).not.toHaveBeenCalled();
  expect(mocks.settleTipMock).not.toHaveBeenCalled();
  expect(mocks.publishMock).not.toHaveBeenCalled();
  expect(mocks.log.info).not.toHaveBeenCalled();
  expect(mocks.log.warn).not.toHaveBeenCalled();
  expect(mocks.log.error).not.toHaveBeenCalled();
}

function unsignedRequest(body: string): Parameters<typeof POST>[0] {
  return new Request(callbackUrl, {
    method: 'POST',
    body,
  }) as Parameters<typeof POST>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('IMAJIN_APP_DID', audience);
  vi.stubEnv('AUTH_SERVICE_URL', 'https://kernel.test/auth');
  discovery.mockResolvedValue(Response.json({
    current: kid,
    keys: [{ kid, publicKey, algorithm: 'Ed25519', validFrom: new Date(0).toISOString() }],
  }));
  // A fresh Response on every discovery (Response bodies are single-use).
  vi.stubGlobal('fetch', (...args: unknown[]) => discovery(...args).then((response: Response) => response.clone()));
  mocks.whereMock.mockResolvedValue(undefined);
  mocks.findTipMock.mockResolvedValue({ ...TIP });
  mocks.settleTipMock.mockResolvedValue('settled');
  mocks.findPageMock.mockResolvedValue({ did: 'did:imajin:creator', title: 'Creator' });
  mocks.publishMock.mockResolvedValue(true);
});

describe('POST /api/webhook/payment — authentication', () => {
  it('accepts a valid kernel signature and processes the callback', async () => {
    const res = await POST(makeRequest({ type: 'payment.succeeded', tipId: 'tip_1' }));
    expect(res.status).toBe(200);
    expect(mocks.updateMock).toHaveBeenCalled();
    expect(discovery).toHaveBeenCalledWith('https://kernel.test/auth/.well-known/kernel-signing-key', expect.any(Object));
  });
  it('rejects unsigned malformed JSON before parsing or business side effects', async () => {
    const res = await POST(unsignedRequest('not json'));
    expect(res.status).toBe(401);
    expectNoSideEffects();
  });

  it('does not accept a legacy Bearer instead of a kernel signature', async () => {
    const request = unsignedRequest(JSON.stringify({ type: 'payment.succeeded', tipId: 'tip_1' }));
    request.headers.set('authorization', 'Bearer FAKE_LEGACY_PLACEHOLDER');
    expect((await POST(request)).status).toBe(401);
    expectNoSideEffects();
  });

  it.each([
    ['x-kernel-signature', '0'.repeat(128)],
    ['x-kernel-nonce', randomUUID()],
    ['x-kernel-timestamp', String(Math.floor(Date.now() / 1000) - 10)],
  ])('rejects a tampered %s header', async (header, value) => {
    const request = makeRequest({ type: 'payment.succeeded', tipId: 'tip_1' });
    request.headers.set(header, value);
    expect((await POST(request)).status).toBe(401);
    expectNoSideEffects();
  });

  it('rejects an unknown kernel key without business side effects', async () => {
    // Separate trusted namespace avoids the SDK's intentional refresh throttle.
    vi.stubEnv('AUTH_SERVICE_URL', 'https://unknown-key-kernel.test/auth');
    const request = makeRequest({ type: 'payment.succeeded', tipId: 'tip_1' });
    request.headers.set('x-kernel-kid', `auth-${'0'.repeat(16)}`);
    expect((await POST(request)).status).toBe(401);
    expectNoSideEffects();
  });

  it('fails closed without exposing discovery errors or performing business side effects', async () => {
    vi.stubEnv('AUTH_SERVICE_URL', 'https://offline-kernel.test/auth');
    discovery.mockRejectedValue(new Error('internal discovery details'));
    const res = await POST(makeRequest({ type: 'payment.succeeded', tipId: 'tip_1' }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Webhook verification unavailable' });
    expectNoSideEffects();
  });
  it.each(['x-kernel-audience', 'x-kernel-timestamp', 'x-kernel-nonce', 'x-kernel-kid', 'x-kernel-signature'])(
    'rejects a missing %s header', async (header) => {
      const request = makeRequest({ tipId: 'tip_1' });
      request.headers.delete(header);
      expect((await POST(request)).status).toBe(401);
      expectNoSideEffects();
    },
  );

  it.each(['missing', 'malformed'] as const)('fails closed with %s local audience configuration', async (configuration) => {
    vi.stubEnv('IMAJIN_APP_DID', configuration === 'missing' ? undefined : 'coffee');
    const res = await POST(makeRequest({ tipId: 'tip_1' }));
    expect(res.status).toBe(401);
    expectNoSideEffects();
  });

  it.each([
    ['a foreign recipient', { audience: 'did:imajin:another-app' }],
    ['a wrong signing key', { privateKey: foreignKey.privateKey }],
    ['an expired timestamp', { timestampOffsetSeconds: -301 }],
    ['a future timestamp', { timestampOffsetSeconds: 301 }],
  ])('rejects %s', async (_label, options) => {
    const res = await POST(makeRequest({ type: 'payment.succeeded', tipId: 'tip_1' }, options));
    expect(res.status).toBe(401);
    expectNoSideEffects();
  });

  it.each([
    ['body bytes', { body: '{ "type": "payment.succeeded", "tipId": "tip_1" }' }],
    ['path', { url: 'https://coffee.test/api/webhook/payment' }],
    ['query', { url: `${callbackUrl}?changed=true` }],
    ['method', { method: 'PUT' }],
  ])('rejects tampered %s', async (_label, changes) => {
    const request = makeRequest({ type: 'payment.succeeded', tipId: 'tip_1' });
    const res = await POST(changedRequest(request, changes));
    expect(res.status).toBe(401);
    expectNoSideEffects();
  });

  it('rejects a replay without repeating any business side effects', async () => {
    const request = makeRequest({ type: 'payment.succeeded', tipId: 'tip_1' });
    const replay = request.clone() as Parameters<typeof POST>[0];
    expect((await POST(request)).status).toBe(200);
    vi.clearAllMocks();
    expect((await POST(replay)).status).toBe(401);
    expectNoSideEffects();
  });

  it('rejects a malformed signature without business side effects', async () => {
    const request = makeRequest({ tipId: 'tip_1' });
    request.headers.set('x-kernel-signature', 'not-a-signature');
    expect((await POST(request)).status).toBe(401);
    expectNoSideEffects();
  });
});

describe('POST /api/webhook/payment — events', () => {
  it.each(['payment.succeeded', 'checkout.completed'])('emits both notifications after %s commits, using stored identities and amounts', async (type) => {
    mocks.publishMock.mockImplementation(async () => {
      expect(mocks.whereMock).toHaveBeenCalledWith({ column: 'id-column', value: 'tip_1' });
      expect(mocks.setMock).toHaveBeenCalledWith({ status: 'completed' });
      return true;
    });
    const response = await POST(makeRequest({ type, tipId: 'tip_1', fromDid: 'did:imajin:forged', amount: 999 }));
    expect(await response.json()).toEqual({ received: true });
    const payload = { amount: 500, currency: 'USD', context_id: 'tip_1', context_type: 'coffee', status: 'completed' };
    expect(mocks.publishMock).toHaveBeenNthCalledWith(1, {
      type: 'tip.granted', subject: 'did:imajin:creator', correlationId: 'tip_1',
      payload: { ...payload, interestDids: ['did:imajin:creator'], tipperName: 'Sam' },
    });
    expect(mocks.publishMock).toHaveBeenNthCalledWith(2, {
      type: 'tip.sent', subject: 'did:imajin:fan', correlationId: 'tip_1',
      payload: { ...payload, interestDids: ['did:imajin:fan'], pageName: 'Creator' },
    });
  });

  it('notifies only the recipient for an anonymous completed tip', async () => {
    mocks.findTipMock.mockResolvedValue({ ...TIP, fromDid: null, fromName: null });
    await POST(makeRequest({ type: 'payment.succeeded', tipId: 'tip_1' }));
    expect(mocks.publishMock).toHaveBeenCalledTimes(1);
    expect(mocks.publishMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'tip.granted', payload: expect.objectContaining({ tipperName: 'Anonymous' }),
    }));
  });

  it('still notifies the sender with a fallback name when the page is missing', async () => {
    mocks.findPageMock.mockResolvedValue(undefined);
    await POST(makeRequest({ type: 'payment.succeeded', tipId: 'tip_1' }));
    expect(mocks.publishMock).toHaveBeenCalledTimes(1);
    expect(mocks.publishMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'tip.sent', payload: expect.objectContaining({ pageName: 'a creator' }),
    }));
    expect(mocks.log.error).toHaveBeenCalled();
  });

  it('keeps acknowledgement and settlement when event delivery fails', async () => {
    mocks.publishMock.mockResolvedValue(false);
    const response = await POST(makeRequest({ type: 'payment.succeeded', tipId: 'tip_1' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true });
    expect(mocks.settleTipMock).toHaveBeenCalledTimes(1);
  });

  it('keeps acknowledgement and settlement when page lookup fails', async () => {
    mocks.findPageMock.mockRejectedValueOnce(new Error('sensitive-db-error'));
    const response = await POST(makeRequest({ type: 'payment.succeeded', tipId: 'tip_1' }));
    expect(response.status).toBe(200);
    expect(mocks.settleTipMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mocks.log.error.mock.calls)).not.toContain('sensitive-db-error');
  });

  it('does not emit on a failed completion write', async () => {
    mocks.whereMock.mockRejectedValueOnce(new Error('db down'));
    expect((await POST(makeRequest({ type: 'payment.succeeded', tipId: 'tip_1' }))).status).toBe(500);
    expect(mocks.publishMock).not.toHaveBeenCalled();
  });
  it('acknowledges events that are not about a tip', async () => {
    const res = await POST(makeRequest({ type: 'payment.succeeded' }));

    expect(await res.json()).toEqual({ received: true });
    expect(mocks.updateMock).not.toHaveBeenCalled();
  });

  it('completes the tip and settles with the transaction id + manifest recorded at checkout', async () => {
    const res = await POST(makeRequest({ type: 'payment.succeeded', tipId: 'tip_1', paymentId: 'pi_1', amount: 500 }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    expect(mocks.setMock).toHaveBeenNthCalledWith(1, { status: 'completed', paymentId: 'pi_1' });
    expect(mocks.whereMock).toHaveBeenNthCalledWith(1, { column: 'id-column', value: 'tip_1' });
    expect(mocks.settleTipMock).toHaveBeenCalledTimes(1);
    expect(mocks.settleTipMock).toHaveBeenCalledWith({ tipId: 'tip_1', payTransactionId: 'tx_1', manifest: MANIFEST });
  });

  it('marks the tip settled once the kernel confirms', async () => {
    await POST(makeRequest({ type: 'payment.succeeded', tipId: 'tip_1' }));

    expect(mocks.setMock).toHaveBeenNthCalledWith(2, { settledAt: expect.any(Date) });
    expect(mocks.whereMock).toHaveBeenNthCalledWith(2, { column: 'id-column', value: 'tip_1' });
  });

  it('treats alreadySettled as success and marks the tip settled', async () => {
    mocks.settleTipMock.mockResolvedValue('already-settled');

    await POST(makeRequest({ type: 'payment.succeeded', tipId: 'tip_1' }));

    expect(mocks.setMock).toHaveBeenNthCalledWith(2, { settledAt: expect.any(Date) });
  });

  it('is idempotent across webhook redelivery: a second delivery does not settle again', async () => {
    // Delivery 1 settles and marks the tip; the tip row then carries settledAt.
    await POST(makeRequest({ type: 'payment.succeeded', tipId: 'tip_1' }));
    expect(mocks.settleTipMock).toHaveBeenCalledTimes(1);
    const settledAt = (mocks.setMock.mock.calls[1] as unknown as [{ settledAt: Date }])[0].settledAt;

    mocks.findTipMock.mockResolvedValue({ ...TIP, settledAt });
    mocks.setMock.mockClear();

    const res = await POST(makeRequest({ type: 'payment.succeeded', tipId: 'tip_1' }));

    expect(res.status).toBe(200);
    expect(mocks.settleTipMock).toHaveBeenCalledTimes(1);
    expect(mocks.setMock).toHaveBeenCalledTimes(1); // only the (harmless) status re-assertion
    expect(mocks.setMock).toHaveBeenCalledWith({ status: 'completed' });
  });

  it('stays retry-safe when the first settle failed: a redelivery settles again', async () => {
    mocks.settleTipMock.mockResolvedValueOnce('failed').mockResolvedValueOnce('already-settled');

    await POST(makeRequest({ type: 'payment.succeeded', tipId: 'tip_1' }));
    expect(mocks.setMock).not.toHaveBeenCalledWith({ settledAt: expect.any(Date) });

    await POST(makeRequest({ type: 'payment.succeeded', tipId: 'tip_1' }));
    expect(mocks.settleTipMock).toHaveBeenCalledTimes(2);
    expect(mocks.setMock).toHaveBeenCalledWith({ settledAt: expect.any(Date) });
  });

  it.each(['not-completed', 'rejected', 'failed'] as const)(
    'completes the tip but does not mark it settled when settle answers %s',
    async (outcome) => {
      mocks.settleTipMock.mockResolvedValue(outcome);

      const res = await POST(makeRequest({ type: 'checkout.completed', tipId: 'tip_1' }));

      expect(res.status).toBe(200);
      expect(mocks.setMock).toHaveBeenCalledTimes(1);
      expect(mocks.setMock).toHaveBeenCalledWith({ status: 'completed' });
    },
  );

  it.each([
    ['no pay transactionId', { ...TIP, payTransactionId: null }],
    ['no payee manifest', { ...TIP, payeeManifest: null }],
    ['a malformed payee manifest', { ...TIP, payeeManifest: { chain: 'nope' } }],
  ])('skips settlement (but still completes the tip) with %s', async (_label, tip) => {
    mocks.findTipMock.mockResolvedValue(tip);

    const res = await POST(makeRequest({ type: 'payment.succeeded', tipId: 'tip_3' }));

    expect(res.status).toBe(200);
    expect(mocks.setMock).toHaveBeenCalledWith({ status: 'completed' });
    expect(mocks.settleTipMock).not.toHaveBeenCalled();
    expect(mocks.log.warn).toHaveBeenCalled();
  });

  it('skips settlement when the tip record cannot be found', async () => {
    mocks.findTipMock.mockResolvedValue(undefined);

    const res = await POST(makeRequest({ type: 'payment.succeeded', tipId: 'tip_4' }));

    expect(res.status).toBe(200);
    expect(mocks.settleTipMock).not.toHaveBeenCalled();
    expect(mocks.log.warn).toHaveBeenCalled();
  });

  describe('paid on the page owner\'s own Stripe account (#2773)', () => {
    const byo = (overrides: Record<string, unknown> = {}) => ({
      type: 'payment.succeeded',
      tipId: 'tip_1',
      paymentId: 'pi_1',
      rail: 'stripe-byo',
      ...overrides,
    });

    it('treats the kernel notification as the settlement: completes the tip, marks it settled, never calls /pay/api/settle', async () => {
      const res = await POST(makeRequest(byo()));

      expect(res.status).toBe(200);
      expect(mocks.setMock).toHaveBeenNthCalledWith(1, { status: 'completed', paymentId: 'pi_1' });
      expect(mocks.setMock).toHaveBeenNthCalledWith(2, { settledAt: expect.any(Date) });
      expect(mocks.whereMock).toHaveBeenNthCalledWith(2, { column: 'id-column', value: 'tip_1' });
      expect(mocks.settleTipMock).not.toHaveBeenCalled();
    });

    it('settles even when the tip has no recorded pay transactionId or payee manifest', async () => {
      mocks.findTipMock.mockResolvedValue({ ...TIP, payTransactionId: null, payeeManifest: null });

      await POST(makeRequest(byo()));

      expect(mocks.settleTipMock).not.toHaveBeenCalled();
      expect(mocks.setMock).toHaveBeenCalledWith({ settledAt: expect.any(Date) });
    });

    it('is idempotent across redelivery: an already-settled tip is not marked again', async () => {
      mocks.findTipMock.mockResolvedValue({ ...TIP, settledAt: new Date() });

      await POST(makeRequest(byo()));

      expect(mocks.setMock).toHaveBeenCalledTimes(1);
      expect(mocks.setMock).not.toHaveBeenCalledWith({ settledAt: expect.any(Date) });
    });

    it('still settles a platform-collected tip (no rail) through /pay/api/settle', async () => {
      await POST(makeRequest(byo({ rail: undefined })));

      expect(mocks.settleTipMock).toHaveBeenCalledTimes(1);
    });
  });

  it('marks the tip failed on payment.failed', async () => {
    const res = await POST(makeRequest({ type: 'payment.failed', tipId: 'tip_5' }));

    expect(res.status).toBe(200);
    expect(mocks.setMock).toHaveBeenCalledWith({ status: 'failed' });
    expect(mocks.settleTipMock).not.toHaveBeenCalled();
  });

  it('acknowledges unknown event types without touching the tip', async () => {
    const res = await POST(makeRequest({ type: 'refund.created', tipId: 'tip_6' }));

    expect(await res.json()).toEqual({ received: true });
    expect(mocks.updateMock).not.toHaveBeenCalled();
  });

  it('returns 500 when the handler throws', async () => {
    mocks.whereMock.mockRejectedValue(new Error('db down'));

    const res = await POST(makeRequest({ type: 'payment.failed', tipId: 'tip_7' }));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Webhook handler failed' });
  });

  it('returns 400 when a correctly signed body is not valid JSON', async () => {
    const res = await POST(makeRequest('not json'));

    expect(res.status).toBe(400);
    expectNoSideEffects();
  });
});
