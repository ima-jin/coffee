import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const valuesMock = vi.fn().mockResolvedValue(undefined);
  return {
    valuesMock,
    insertMock: vi.fn(() => ({ values: valuesMock })),
    findFirstMock: vi.fn(),
    rateLimitMock: vi.fn(),
    optionalCallerDidMock: vi.fn(),
    fetchMock: vi.fn(),
    getAppServiceTokenMock: vi.fn(),
  };
});

vi.mock('@ima-jin/logger', () => ({ createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) }));
vi.mock('@ima-jin/config', () => ({ rateLimit: mocks.rateLimitMock, getClientIP: () => '127.0.0.1' }));
vi.mock('@/db', () => ({
  db: { insert: mocks.insertMock, query: { coffeePages: { findFirst: mocks.findFirstMock } } },
  tips: {},
}));
vi.mock('@/lib/app-service-token', () => ({ getAppServiceToken: mocks.getAppServiceTokenMock }));
vi.mock('@/lib/auth/authenticate', () => ({ optionalCallerDid: mocks.optionalCallerDidMock }));

import { POST } from '../route';

function makeRequest(body: unknown): Parameters<typeof POST>[0] {
  return new Request('https://coffee.test/api/tip', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }) as Parameters<typeof POST>[0];
}

const PAGE = {
  id: 'page_1',
  did: 'did:imajin:creator',
  handle: 'creator',
  title: 'Creator Page',
  isPublic: true,
  allowMessages: true,
  paymentMethods: { stripe: { enabled: true }, solana: { enabled: true, address: 'sol-address-1' } },
};

const STRIPE_BODY = { pageHandle: 'creator', amount: 500, paymentMethod: 'stripe' };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', mocks.fetchMock);
  vi.stubEnv('PAY_SERVICE_URL', 'https://kernel.test/pay');
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://coffee.test');
  vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '');
  mocks.rateLimitMock.mockReturnValue({ limited: false, retryAfter: 0 });
  mocks.optionalCallerDidMock.mockResolvedValue(null);
  mocks.valuesMock.mockResolvedValue(undefined);
  mocks.findFirstMock.mockResolvedValue(PAGE);
  mocks.getAppServiceTokenMock.mockResolvedValue('app-service-token');
  mocks.fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ id: 'cs_1', url: 'https://checkout.test/cs_1', transactionId: 'tx_1' }),
  });
});

const EXPECTED_MANIFEST = {
  chain: [
    { did: 'did:imajin:creator', role: 'creator', amount: 4.93 },
    { did: 'did:imajin:platform', role: 'platform', amount: 0.07 },
  ],
};

describe('POST /api/tip — guards', () => {
  it('returns 429 when rate limited', async () => {
    mocks.rateLimitMock.mockReturnValue({ limited: true, retryAfter: 15 });

    const res = await POST(makeRequest(STRIPE_BODY));

    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe('Too many requests. Retry after 15s');
  });

  it.each([
    [{ amount: 500, paymentMethod: 'stripe' }, 'pageHandle is required'],
    [{ pageHandle: 'creator', paymentMethod: 'stripe' }, 'amount must be at least 100 cents ($1)'],
    [{ pageHandle: 'creator', amount: 99, paymentMethod: 'stripe' }, 'amount must be at least 100 cents ($1)'],
    [{ pageHandle: 'creator', amount: 500 }, 'paymentMethod must be stripe or solana'],
    [{ pageHandle: 'creator', amount: 500, paymentMethod: 'paypal' }, 'paymentMethod must be stripe or solana'],
  ])('rejects an invalid body with 400 (%j)', async (body, message) => {
    const res = await POST(makeRequest(body));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(message);
  });

  it('returns 404 when the page does not exist', async () => {
    mocks.findFirstMock.mockResolvedValue(undefined);

    expect((await POST(makeRequest(STRIPE_BODY))).status).toBe(404);
  });

  it('returns 403 when the page is private', async () => {
    mocks.findFirstMock.mockResolvedValue({ ...PAGE, isPublic: false });

    const res = await POST(makeRequest(STRIPE_BODY));

    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('This page is not accepting tips');
  });

  it('rejects stripe when the page has not enabled it', async () => {
    mocks.findFirstMock.mockResolvedValue({ ...PAGE, paymentMethods: { stripe: { enabled: false } } });

    const res = await POST(makeRequest(STRIPE_BODY));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Card payments not enabled for this page');
  });

  it('rejects solana when the page has not enabled it', async () => {
    mocks.findFirstMock.mockResolvedValue({ ...PAGE, paymentMethods: { stripe: { enabled: true } } });

    const res = await POST(makeRequest({ ...STRIPE_BODY, paymentMethod: 'solana' }));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Solana payments not enabled for this page');
  });

  it('rejects a payment method when the page has no payment methods at all', async () => {
    mocks.findFirstMock.mockResolvedValue({ ...PAGE, paymentMethods: null });

    expect((await POST(makeRequest(STRIPE_BODY))).status).toBe(400);
  });

  it('rejects a message when the page does not allow messages', async () => {
    mocks.findFirstMock.mockResolvedValue({ ...PAGE, allowMessages: false });

    const res = await POST(makeRequest({ ...STRIPE_BODY, message: 'hi' }));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('This page does not accept messages with tips');
  });

  it('returns 500 when the body cannot be parsed', async () => {
    expect((await POST(makeRequest('not json'))).status).toBe(500);
  });
});

describe('POST /api/tip — stripe', () => {
  it('creates a pending tip and returns the checkout URL for an anonymous tipper', async () => {
    const res = await POST(makeRequest({ ...STRIPE_BODY, fromName: 'Sam', message: 'Thanks', fundDirection: 'fd_1' }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ url: 'https://checkout.test/cs_1', paymentMethod: 'stripe' });
    expect(body.tipId).toMatch(/^tip_/);

    const [url, init] = mocks.fetchMock.mock.calls[0];
    expect(url).toBe('https://kernel.test/pay/api/checkout');
    expect(init.headers.Authorization).toBe('Bearer app-service-token');
    const sent = JSON.parse(init.body);
    expect(sent).toMatchObject({
      sellerDid: 'did:imajin:creator',
      payeeManifest: EXPECTED_MANIFEST,
      currency: 'USD',
      mode: 'payment',
      successUrl: 'https://coffee.test/success?handle=creator',
      cancelUrl: 'https://coffee.test/creator',
      metadata: {
        service: 'coffee',
        type: 'tip',
        pageId: 'page_1',
        pageHandle: 'creator',
        to_did: 'did:imajin:creator',
        fromDid: 'anonymous',
        fromName: 'Sam',
        message: 'Thanks',
        fundDirection: 'fd_1',
      },
    });
    expect(sent.items[0]).toMatchObject({ name: 'Tip for Creator Page', description: '"Thanks" — Sam', amount: 500 });

    expect(mocks.valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        pageId: 'page_1',
        fromDid: null,
        fromName: 'Sam',
        amount: 500,
        currency: 'USD',
        message: 'Thanks',
        paymentMethod: 'stripe',
        paymentId: 'cs_1',
        payTransactionId: 'tx_1',
        payeeManifest: EXPECTED_MANIFEST,
        status: 'pending',
      }),
    );
  });

  it('still records the tip (unsettleable) when pay returns no transactionId', async () => {
    mocks.fetchMock.mockResolvedValue({ ok: true, json: async () => ({ id: 'cs_1', url: 'https://checkout.test/cs_1' }) });

    const res = await POST(makeRequest(STRIPE_BODY));

    expect(res.status).toBe(200);
    expect(mocks.valuesMock).toHaveBeenCalledWith(expect.objectContaining({ payTransactionId: null }));
  });

  it('returns 500 and never calls pay when the app-service token cannot be minted', async () => {
    mocks.getAppServiceTokenMock.mockRejectedValue(new Error('mint refused'));

    const res = await POST(makeRequest(STRIPE_BODY));

    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('Failed to process tip');
    expect(mocks.fetchMock).not.toHaveBeenCalled();
    expect(mocks.valuesMock).not.toHaveBeenCalled();
  });

  it('attributes the tip to an authenticated caller and supports monthly recurring tips', async () => {
    mocks.optionalCallerDidMock.mockResolvedValue('did:imajin:fan');

    const res = await POST(makeRequest({ ...STRIPE_BODY, recurring: true, currency: 'eur' }));

    expect(res.status).toBe(200);
    const sent = JSON.parse(mocks.fetchMock.mock.calls[0][1].body);
    expect(sent.mode).toBe('subscription');
    expect(sent.currency).toBe('EUR');
    expect(sent.successUrl).toBe('https://coffee.test/success?handle=creator&type=subscription');
    expect(sent.metadata.fromDid).toBe('did:imajin:fan');
    expect(sent.metadata.fromName).toBe('Anonymous');
    expect(sent.metadata).not.toHaveProperty('fundDirection');
    expect(sent.items[0].description).toBe('From Anonymous');
    expect(mocks.valuesMock).toHaveBeenCalledWith(expect.objectContaining({ fromDid: 'did:imajin:fan', fromName: null, message: null }));
  });

  it('falls back to the handle in the item name when the page has no title', async () => {
    mocks.findFirstMock.mockResolvedValue({ ...PAGE, title: '' });

    await POST(makeRequest(STRIPE_BODY));

    expect(JSON.parse(mocks.fetchMock.mock.calls[0][1].body).items[0].name).toBe('Tip for creator');
  });

  it('returns 500 and records nothing when the pay service refuses the checkout', async () => {
    mocks.fetchMock.mockResolvedValue({ ok: false, text: async () => 'card declined' });

    const res = await POST(makeRequest(STRIPE_BODY));

    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('Failed to create payment');
    expect(mocks.valuesMock).not.toHaveBeenCalled();
  });

  it('returns 500 when PAY_SERVICE_URL is not configured', async () => {
    vi.stubEnv('PAY_SERVICE_URL', '');

    const res = await POST(makeRequest(STRIPE_BODY));

    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('Failed to process tip');
  });
});

describe('POST /api/tip — solana', () => {
  const SOLANA_BODY = { pageHandle: 'creator', amount: 500, paymentMethod: 'solana' };

  it('records a pending SOL tip and returns the destination address without calling pay', async () => {
    mocks.optionalCallerDidMock.mockResolvedValue('did:imajin:fan');

    const res = await POST(makeRequest({ ...SOLANA_BODY, fromName: 'Sam', message: 'gm' }));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ solanaAddress: 'sol-address-1', amount: 500, paymentMethod: 'solana' });
    expect(mocks.fetchMock).not.toHaveBeenCalled();
    expect(mocks.valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        fromDid: 'did:imajin:fan',
        fromName: 'Sam',
        currency: 'SOL',
        message: 'gm',
        paymentMethod: 'solana',
        paymentId: 'pending',
        status: 'pending',
      }),
    );
  });

  it('records null name/message when none were supplied', async () => {
    await POST(makeRequest(SOLANA_BODY));

    expect(mocks.valuesMock).toHaveBeenCalledWith(expect.objectContaining({ fromDid: null, fromName: null, message: null }));
  });
});
