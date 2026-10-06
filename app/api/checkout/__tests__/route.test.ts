import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rateLimitMock: vi.fn(), fetchMock: vi.fn() }));

vi.mock('@ima-jin/logger', () => ({ createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) }));
vi.mock('@ima-jin/config', () => ({ rateLimit: mocks.rateLimitMock, getClientIP: () => '127.0.0.1' }));

import { POST } from '../route';

function makeRequest(body: unknown): Parameters<typeof POST>[0] {
  return new Request('https://coffee.test/api/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }) as Parameters<typeof POST>[0];
}

const VALID_BODY = { amount: 1000, recurring: false, joinMailingList: false };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', mocks.fetchMock);
  vi.stubEnv('PAY_SERVICE_URL', 'https://kernel.test/pay');
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://coffee.test');
  vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '');
  mocks.rateLimitMock.mockReturnValue({ limited: false, retryAfter: 0 });
  mocks.fetchMock.mockResolvedValue({ ok: true, json: async () => ({ url: 'https://checkout.test/session_1' }) });
});

describe('POST /api/checkout', () => {
  it('returns 429 with Retry-After when rate limited, without calling pay', async () => {
    mocks.rateLimitMock.mockReturnValue({ limited: true, retryAfter: 30 });

    const res = await POST(makeRequest(VALID_BODY));

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('30');
    expect(await res.json()).toEqual({ error: 'Too many requests', retryAfter: 30 });
    expect(mocks.fetchMock).not.toHaveBeenCalled();
  });

  it.each([{}, { amount: 499 }])('rejects an amount below the $5 minimum (%j)', async (body) => {
    const res = await POST(makeRequest(body));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Minimum amount is $5');
    expect(mocks.fetchMock).not.toHaveBeenCalled();
  });

  it('creates a one-time checkout and returns the URL', async () => {
    const res = await POST(makeRequest(VALID_BODY));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: 'https://checkout.test/session_1' });

    const [url, init] = mocks.fetchMock.mock.calls[0];
    expect(url).toBe('https://kernel.test/pay/api/checkout');
    expect(JSON.parse(init.body)).toEqual({
      mode: 'payment',
      items: [
        {
          name: 'Support Imajin',
          description: 'One-time support for sovereign infrastructure development',
          amount: 1000,
          quantity: 1,
        },
      ],
      currency: 'USD',
      successUrl: 'https://coffee.test/success?type=onetime',
      cancelUrl: 'https://coffee.test',
      metadata: { service: 'coffee', type: 'checkout', joinMailingList: 'false' },
    });
  });

  it('creates a monthly subscription checkout and carries the mailing-list opt-in', async () => {
    await POST(makeRequest({ amount: 500, recurring: true, joinMailingList: true }));

    const sent = JSON.parse(mocks.fetchMock.mock.calls[0][1].body);
    expect(sent.mode).toBe('subscription');
    expect(sent.items[0].name).toBe('Support Imajin (Monthly)');
    expect(sent.items[0].description).toBe('Monthly support for sovereign infrastructure development');
    expect(sent.successUrl).toBe('https://coffee.test/success?type=subscription');
    expect(sent.metadata).toEqual({ service: 'coffee', type: 'subscription', joinMailingList: 'true' });
  });

  it('returns 500 without leaking upstream details when pay refuses', async () => {
    mocks.fetchMock.mockResolvedValue({ ok: false, text: async () => 'Stripe error' });

    const res = await POST(makeRequest(VALID_BODY));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to create checkout' });
  });

  it('returns 500 when the body cannot be parsed', async () => {
    const res = await POST(makeRequest('not json'));

    expect(res.status).toBe(500);
    expect(mocks.fetchMock).not.toHaveBeenCalled();
  });
});
