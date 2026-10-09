import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const whereMock = vi.fn().mockResolvedValue(undefined);
  const setMock = vi.fn(() => ({ where: whereMock }));
  return {
    whereMock,
    setMock,
    updateMock: vi.fn(() => ({ set: setMock })),
    findTipMock: vi.fn(),
    settleTipMock: vi.fn(),
    log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  };
});

vi.mock('@ima-jin/logger', () => ({ createLogger: () => mocks.log }));
vi.mock('drizzle-orm', () => ({ eq: vi.fn((column: unknown, value: unknown) => ({ column, value })) }));
vi.mock('@/db', () => ({
  db: {
    update: mocks.updateMock,
    query: { tips: { findFirst: mocks.findTipMock } },
  },
  tips: { id: 'id-column' },
}));
vi.mock('@/lib/settle', () => ({ settleTip: mocks.settleTipMock }));

import { POST } from '../route';

const SECRET = 'webhook-secret';

const MANIFEST = {
  chain: [
    { did: 'did:imajin:creator', role: 'creator', amount: 4.93 },
    { did: 'did:imajin:platform', role: 'platform', amount: 0.07 },
  ],
};

const TIP = { id: 'tip_1', payTransactionId: 'tx_1', payeeManifest: MANIFEST, settledAt: null };

function makeRequest(body: unknown, authorization: string | null = `Bearer ${SECRET}`): Parameters<typeof POST>[0] {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (authorization !== null) headers.authorization = authorization;
  return new Request('https://coffee.test/api/webhook/payment', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }) as Parameters<typeof POST>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('WEBHOOK_SECRET', SECRET);
  mocks.whereMock.mockResolvedValue(undefined);
  mocks.findTipMock.mockResolvedValue({ ...TIP });
  mocks.settleTipMock.mockResolvedValue('settled');
});

describe('POST /api/webhook/payment — authentication', () => {
  it('answers 500 when no webhook secret is configured', async () => {
    vi.stubEnv('WEBHOOK_SECRET', '');

    const res = await POST(makeRequest({ tipId: 'tip_1' }));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Webhook not configured' });
  });

  it.each([null, 'Bearer wrong', SECRET, `Bearer ${SECRET}x`])('rejects authorization %j with 401', async (header) => {
    const res = await POST(makeRequest({ tipId: 'tip_1' }, header));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(mocks.updateMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/webhook/payment — events', () => {
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

  it('returns 500 when the body is not valid JSON', async () => {
    const res = await POST(makeRequest('not json'));

    expect(res.status).toBe(500);
  });
});
