import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const returningMock = vi.fn();
  const valuesMock = vi.fn((...args: [Record<string, unknown>]) => ({ returning: returningMock, args }));
  return {
    returningMock,
    valuesMock,
    insertMock: vi.fn(() => ({ values: valuesMock })),
    findFirstMock: vi.fn(),
    authenticateMock: vi.fn(),
    getNodeSelfMock: vi.fn(),
  };
});

vi.mock('@ima-jin/logger', () => ({ createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) }));
vi.mock('@ima-jin/config', () => ({ getNodeSelf: mocks.getNodeSelfMock }));
vi.mock('@/db', () => ({
  db: { query: { coffeePages: { findFirst: mocks.findFirstMock } }, insert: mocks.insertMock },
  coffeePages: {},
}));
vi.mock('@/lib/auth/authenticate', () => ({ authenticate: mocks.authenticateMock }));

import { POST } from '../route';

function makeRequest(body: unknown): Parameters<typeof POST>[0] {
  return new Request('https://coffee.test/api/pages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }) as Parameters<typeof POST>[0];
}

const VALID_BODY = { handle: 'creator_1', title: 'My Page', paymentMethods: { stripe: { enabled: true } } };

function insertedValues(): Record<string, unknown> {
  return mocks.valuesMock.mock.calls[0][0];
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authenticateMock.mockResolvedValue({ auth: { did: 'did:imajin:creator', scopes: [], via: 'token' } });
  mocks.findFirstMock.mockResolvedValue(undefined);
  mocks.getNodeSelfMock.mockResolvedValue(null);
  mocks.returningMock.mockImplementation(async () => [mocks.valuesMock.mock.calls.at(-1)?.[0]]);
});

describe('POST /api/pages', () => {
  it('returns the auth failure when unauthenticated', async () => {
    mocks.authenticateMock.mockResolvedValue({ error: 'Authorization required', status: 401 });

    const res = await POST(makeRequest(VALID_BODY));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Authorization required' });
    expect(mocks.insertMock).not.toHaveBeenCalled();
  });

  it.each([
    [{ title: 'T', paymentMethods: { stripe: {} } }, 'handle is required'],
    [{ handle: 'creator_1', paymentMethods: { stripe: {} } }, 'title is required'],
    [{ handle: 'Bad-Handle', title: 'T', paymentMethods: { stripe: {} } }, 'Handle must be 3-30 characters'],
    [{ handle: 'creator_1', title: 'T' }, 'At least one payment method'],
    [{ handle: 'creator_1', title: 'T', paymentMethods: {} }, 'At least one payment method'],
  ])('rejects invalid bodies with 400 (%j)', async (body, message) => {
    const res = await POST(makeRequest(body));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain(message);
    expect(mocks.insertMock).not.toHaveBeenCalled();
  });

  it('returns 409 when the DID already has a page', async () => {
    mocks.findFirstMock.mockResolvedValueOnce({ id: 'page_existing' });

    const res = await POST(makeRequest(VALID_BODY));

    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('You already have a coffee page');
  });

  it('returns 409 when the handle is taken', async () => {
    mocks.findFirstMock.mockResolvedValueOnce(undefined).mockResolvedValueOnce({ id: 'page_other' });

    const res = await POST(makeRequest(VALID_BODY));

    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('Handle is already taken');
  });

  it('creates the page for the authenticated DID with defaults and the creator as the .fair seller', async () => {
    const res = await POST(makeRequest(VALID_BODY));

    expect(res.status).toBe(201);
    const values = insertedValues();
    expect(values).toMatchObject({
      did: 'did:imajin:creator',
      handle: 'creator_1',
      title: 'My Page',
      bio: null,
      avatar: null,
      avatarAssetId: null,
      theme: {},
      presets: [100, 500, 1000],
      thankYouContent: null,
      allowCustomAmount: true,
      allowMessages: true,
      isPublic: true,
    });
    expect(values.id).toMatch(/^page_/);

    const manifest = values.fairManifest as { chain: Array<{ did: string; role: string }> };
    const seller = manifest.chain.find((entry) => entry.role === 'seller');
    expect(seller?.did).toBe('did:imajin:creator');
  });

  it('persists the supplied optional fields and honours explicit false flags', async () => {
    const res = await POST(
      makeRequest({
        ...VALID_BODY,
        bio: 'Hello',
        avatar: '☕',
        avatarAssetId: 'asset_1',
        theme: { primaryColor: '#fff' },
        presets: [200],
        thankYouContent: 'Thanks!',
        allowCustomAmount: false,
        allowMessages: false,
      }),
    );

    expect(res.status).toBe(201);
    expect(insertedValues()).toMatchObject({
      bio: 'Hello',
      avatar: '☕',
      avatarAssetId: 'asset_1',
      theme: { primaryColor: '#fff' },
      presets: [200],
      thankYouContent: 'Thanks!',
      allowCustomAmount: false,
      allowMessages: false,
    });
  });

  it("feeds the registry's node config into the .fair manifest", async () => {
    mocks.getNodeSelfMock.mockResolvedValue({
      nodeFeeBps: 250,
      buyerCreditBps: 100,
      nodeOperatorDid: 'did:imajin:operator',
    });

    await POST(makeRequest(VALID_BODY));

    const manifest = insertedValues().fairManifest as { chain: Array<{ did: string; role: string }> };
    expect(manifest.chain.find((entry) => entry.role === 'node')?.did).toBe('did:imajin:operator');
  });

  it('returns 500 when persistence fails', async () => {
    mocks.returningMock.mockRejectedValue(new Error('db down'));

    const res = await POST(makeRequest(VALID_BODY));

    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('Failed to create coffee page');
  });

  it('returns 500 when the body is not valid JSON', async () => {
    const res = await POST(makeRequest('not json'));

    expect(res.status).toBe(500);
  });
});
