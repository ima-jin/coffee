import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const whereMock = vi.fn().mockResolvedValue(undefined);
  const setMock = vi.fn(() => ({ where: whereMock }));
  return {
    whereMock,
    setMock,
    updateMock: vi.fn(() => ({ set: setMock })),
    findPageMock: vi.fn(),
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
    query: { coffeePages: { findFirst: mocks.findPageMock }, tips: { findFirst: mocks.findTipMock } },
  },
  tips: { id: 'id-column' },
}));
vi.mock('@/lib/settle', () => ({ settleTip: mocks.settleTipMock }));

import { POST } from '../route';

const SECRET = 'webhook-secret';

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
  mocks.findPageMock.mockResolvedValue(undefined);
  mocks.findTipMock.mockResolvedValue(undefined);
  mocks.settleTipMock.mockResolvedValue(undefined);
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

  it('completes the tip and settles the .fair split using the payload', async () => {
    const res = await POST(
      makeRequest({
        type: 'payment.succeeded',
        tipId: 'tip_1',
        paymentId: 'pi_1',
        amount: 500,
        fromDid: 'did:imajin:fan',
        to_did: 'did:imajin:creator',
        pageId: 'page_1',
        stripeSessionId: 'cs_1',
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    expect(mocks.setMock).toHaveBeenCalledWith({ status: 'completed', paymentId: 'pi_1' });
    expect(mocks.whereMock).toHaveBeenCalledWith({ column: 'id-column', value: 'tip_1' });
    expect(mocks.settleTipMock).toHaveBeenCalledWith({
      tipId: 'tip_1',
      recipientDid: 'did:imajin:creator',
      fromDid: 'did:imajin:fan',
      amount: 500,
      currency: 'USD',
      stripeSessionId: 'cs_1',
    });
    expect(mocks.findPageMock).not.toHaveBeenCalled();
    expect(mocks.findTipMock).not.toHaveBeenCalled();
  });

  it('treats checkout.completed like payment.succeeded, falling back to the stored page and tip amount', async () => {
    mocks.findPageMock.mockResolvedValue({ did: 'did:imajin:creator' });
    mocks.findTipMock.mockResolvedValue({ amount: 700 });

    await POST(makeRequest({ type: 'checkout.completed', tipId: 'tip_2', pageId: 'page_1' }));

    expect(mocks.setMock).toHaveBeenCalledWith({ status: 'completed' });
    expect(mocks.settleTipMock).toHaveBeenCalledWith(
      expect.objectContaining({ tipId: 'tip_2', recipientDid: 'did:imajin:creator', fromDid: null, amount: 700 }),
    );
  });

  it('skips settlement (but still completes the tip) when the recipient cannot be resolved', async () => {
    const res = await POST(makeRequest({ type: 'payment.succeeded', tipId: 'tip_3', amount: 500 }));

    expect(res.status).toBe(200);
    expect(mocks.setMock).toHaveBeenCalledWith({ status: 'completed' });
    expect(mocks.settleTipMock).not.toHaveBeenCalled();
    expect(mocks.log.warn).toHaveBeenCalled();
  });

  it('skips settlement when no amount is known anywhere', async () => {
    await POST(makeRequest({ type: 'payment.succeeded', tipId: 'tip_4', to_did: 'did:imajin:creator' }));

    expect(mocks.settleTipMock).not.toHaveBeenCalled();
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
