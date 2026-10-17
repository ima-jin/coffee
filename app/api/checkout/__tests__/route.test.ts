import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  rateLimitMock: vi.fn(),
  fetchMock: vi.fn(),
  authenticateMock: vi.fn(),
  findFirstMock: vi.fn(),
  getAppServiceTokenMock: vi.fn(),
  logErrorMock: vi.fn(),
}));

vi.mock('@ima-jin/logger', () => ({ createLogger: () => ({ error: mocks.logErrorMock, warn: vi.fn(), info: vi.fn() }) }));
vi.mock('@ima-jin/config', () => ({ rateLimit: mocks.rateLimitMock, getClientIP: () => '127.0.0.1' }));
vi.mock('@/db', () => ({
  db: { query: { coffeePages: { findFirst: mocks.findFirstMock } } },
}));
vi.mock('@/lib/app-service-token', () => ({ getAppServiceToken: mocks.getAppServiceTokenMock }));

vi.mock('@ima-jin/auth', () => ({ requireSessionOrAppToken: mocks.authenticateMock }));
vi.mock('@ima-jin/auth-client', () => ({ getSession: vi.fn().mockResolvedValue(null) }));
vi.mock('@/lib/auth-config', () => ({ authConfig: {} }));

import { POST } from '../route';

function makeRequest(body: unknown): Parameters<typeof POST>[0] {
  return new Request('https://coffee.test/api/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }) as Parameters<typeof POST>[0];
}

const PAGE = { handle: 'imajin', did: 'did:imajin:page-owner', isPublic: true };
const VALID_BODY = { pageHandle: PAGE.handle, amount: 1000, recurring: false, joinMailingList: false };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authenticateMock.mockResolvedValue({ error: 'Not authenticated', status: 401 });
  vi.stubGlobal('fetch', mocks.fetchMock);
  vi.stubEnv('PAY_SERVICE_URL', 'https://kernel.test/pay');
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://coffee.test');
  vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '');
  mocks.rateLimitMock.mockReturnValue({ limited: false, retryAfter: 0 });
  mocks.findFirstMock.mockResolvedValue(PAGE);
  mocks.getAppServiceTokenMock.mockResolvedValue('test-app-service-token');
  mocks.fetchMock.mockResolvedValue({ ok: true, json: async () => ({ url: 'https://checkout.test/session_1' }) });
});

describe('POST /api/checkout', () => {
  it.each(['token', 'cookie'])('allows a reversible hosted checkout proposal for a %s delegate', async (via) => {
    mocks.authenticateMock.mockResolvedValue({
      auth: { did: 'did:imajin:agent', actingFor: 'did:imajin:owner', scopes: [], via },
    });
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: 'https://checkout.test/session_1' });
    expect(mocks.fetchMock).toHaveBeenCalledOnce();
    expect(mocks.fetchMock.mock.calls[0][0]).toBe('https://kernel.test/pay/api/checkout');
    expect(mocks.fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer test-app-service-token');
    expect(JSON.parse(mocks.fetchMock.mock.calls[0][1].body).sellerDid).toBe(PAGE.did);
  });

  it('uses the resolved owner of a different page, not a fixed seller or the payer', async () => {
    mocks.findFirstMock.mockResolvedValue({ ...PAGE, handle: 'another-page', did: 'did:imajin:another-owner' });
    mocks.authenticateMock.mockResolvedValue({ auth: { did: 'did:imajin:payer', via: 'cookie', scopes: [] } });

    const res = await POST(makeRequest({ ...VALID_BODY, pageHandle: 'another-page', sellerDid: 'did:imajin:attacker' }));

    expect(res.status).toBe(200);
    expect(JSON.parse(mocks.fetchMock.mock.calls[0][1].body).sellerDid).toBe('did:imajin:another-owner');
  });

  it.each([403, 503])('does not downgrade an auth failure (%s) to anonymous checkout', async (status) => {
    mocks.authenticateMock.mockResolvedValue({ error: 'Auth refused', status });
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: 'Auth refused' });
    expect(mocks.fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed without calling pay for an unclassified delegated mutation', async () => {
    mocks.authenticateMock.mockResolvedValue({
      auth: { did: 'did:imajin:agent', actingFor: 'did:imajin:owner', scopes: [], via: 'token' },
    });
    const req = new Request('https://coffee.test/api/future', { method: 'POST', body: JSON.stringify(VALID_BODY) });
    const res = await POST(req as Parameters<typeof POST>[0]);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'AGENT_APPROVAL_REQUIRED', action: 'unclassified-mutation' });
    expect(mocks.fetchMock).not.toHaveBeenCalled();
  });
  it('returns 429 with Retry-After when rate limited, without calling pay', async () => {
    mocks.rateLimitMock.mockReturnValue({ limited: true, retryAfter: 30 });

    const res = await POST(makeRequest(VALID_BODY));

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('30');
    expect(await res.json()).toEqual({ error: 'Too many requests', retryAfter: 30 });
    expect(mocks.fetchMock).not.toHaveBeenCalled();
  });

  it.each([undefined, null, 0, -1, 499, 500.5, '1000', true, [], {}, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid or below-minimum cents (%j)', async (amount) => {
      const res = await POST(makeRequest({ ...VALID_BODY, amount }));

      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('Amount must be an integer in cents (minimum $5)');
      expect(mocks.findFirstMock).not.toHaveBeenCalled();
      expect(mocks.getAppServiceTokenMock).not.toHaveBeenCalled();
      expect(mocks.fetchMock).not.toHaveBeenCalled();
    });

  it.each(['1e400', 'NaN'])('does not forward a non-finite amount (%s)', async (amount) => {
    const res = await POST(makeRequest(`{"pageHandle":"imajin","amount":${amount}}`));

    expect(res.ok).toBe(false);
    expect(mocks.fetchMock).not.toHaveBeenCalled();
  });

  it.each([undefined, null, '', '  ', 123, {}, []])('requires a page handle (%j)', async (pageHandle) => {
    const res = await POST(makeRequest({ ...VALID_BODY, pageHandle }));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('pageHandle is required');
    expect(mocks.findFirstMock).not.toHaveBeenCalled();
    expect(mocks.getAppServiceTokenMock).not.toHaveBeenCalled();
    expect(mocks.fetchMock).not.toHaveBeenCalled();
  });

  it('queries the requested page by handle, not by client-supplied owner', async () => {
    await POST(makeRequest({ ...VALID_BODY, sellerDid: 'did:imajin:attacker' }));

    const { where } = mocks.findFirstMock.mock.calls[0][0];
    const eq = vi.fn();
    where({ handle: 'handle-column' }, { eq });
    expect(eq).toHaveBeenCalledWith('handle-column', PAGE.handle);
    const sent = JSON.parse(mocks.fetchMock.mock.calls[0][1].body);
    expect(sent.sellerDid).toBe(PAGE.did);
  });

  it('ignores spoofed seller fields in the body and metadata', async () => {
    const res = await POST(makeRequest({
      ...VALID_BODY,
      sellerDid: 'did:imajin:attacker',
      metadata: { sellerDid: 'did:imajin:attacker' },
    }));

    expect(res.status).toBe(200);
    const sent = JSON.parse(mocks.fetchMock.mock.calls[0][1].body);
    expect(sent.sellerDid).toBe(PAGE.did);
    expect(sent.metadata.sellerDid).toBeUndefined();
    expect(mocks.fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer test-app-service-token');
  });

  it('returns 404 without minting or calling pay for a missing page', async () => {
    mocks.findFirstMock.mockResolvedValue(undefined);
    const res = await POST(makeRequest(VALID_BODY));

    expect(res.status).toBe(404);
    expect(mocks.getAppServiceTokenMock).not.toHaveBeenCalled();
    expect(mocks.fetchMock).not.toHaveBeenCalled();
  });

  it('does not accept support for a private page', async () => {
    mocks.findFirstMock.mockResolvedValue({ ...PAGE, isPublic: false });
    const res = await POST(makeRequest(VALID_BODY));

    expect(res.status).toBe(403);
    expect(mocks.getAppServiceTokenMock).not.toHaveBeenCalled();
    expect(mocks.fetchMock).not.toHaveBeenCalled();
  });

  it.each([false, true])('fails closed on mint failure without logging details, then allows a retry (recurring=%s)', async (recurring) => {
    mocks.getAppServiceTokenMock.mockRejectedValueOnce(new Error('private mint diagnostic'));
    const res = await POST(makeRequest({ ...VALID_BODY, recurring }));

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Payment service unavailable; please retry checkout' });
    expect(mocks.fetchMock).not.toHaveBeenCalled();
    expect(mocks.logErrorMock).not.toHaveBeenCalled();

    const retry = await POST(makeRequest({ ...VALID_BODY, recurring }));
    expect(retry.status).toBe(200);
    expect(mocks.fetchMock).toHaveBeenCalledOnce();
    expect(mocks.fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer test-app-service-token');
  });

  it('fails closed with 503 if the token source yields an empty token', async () => {
    mocks.getAppServiceTokenMock.mockResolvedValue('');
    const res = await POST(makeRequest(VALID_BODY));

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Payment service unavailable; please retry checkout' });
    expect(mocks.fetchMock).not.toHaveBeenCalled();
  });

  it('creates a one-time checkout and returns the URL', async () => {
    const res = await POST(makeRequest(VALID_BODY));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: 'https://checkout.test/session_1' });

    const [url, init] = mocks.fetchMock.mock.calls[0];
    expect(url).toBe('https://kernel.test/pay/api/checkout');
    expect(init.headers.Authorization).toBe('Bearer test-app-service-token');
    expect(JSON.parse(init.body)).toEqual({
      sellerDid: PAGE.did,
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
    await POST(makeRequest({ ...VALID_BODY, amount: 500, recurring: true, joinMailingList: true }));

    const sent = JSON.parse(mocks.fetchMock.mock.calls[0][1].body);
    expect(mocks.fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer test-app-service-token');
    expect(sent.sellerDid).toBe(PAGE.did);
    expect(sent.mode).toBe('subscription');
    expect(sent.items[0].name).toBe('Support Imajin (Monthly)');
    expect(sent.items[0].description).toBe('Monthly support for sovereign infrastructure development');
    expect(sent.successUrl).toBe('https://coffee.test/success?type=subscription');
    expect(sent.metadata).toEqual({ service: 'coffee', type: 'subscription', joinMailingList: 'true' });
  });

  it('returns 500 without leaking upstream details when pay refuses', async () => {
    mocks.fetchMock.mockResolvedValue({ ok: false, status: 401, text: async () => 'private upstream diagnostic' });

    const res = await POST(makeRequest(VALID_BODY));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to create checkout' });
    expect(mocks.fetchMock).toHaveBeenCalledOnce();
    expect(mocks.logErrorMock).toHaveBeenCalledWith({ status: 401 }, 'Pay service checkout failed');
  });

  it('returns 500 when the body cannot be parsed', async () => {
    const res = await POST(makeRequest('not json'));

    expect(res.status).toBe(500);
    expect(mocks.fetchMock).not.toHaveBeenCalled();
  });
});
