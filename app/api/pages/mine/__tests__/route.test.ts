import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ findFirstMock: vi.fn(), authenticateMock: vi.fn() }));

vi.mock('@ima-jin/logger', () => ({ createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) }));
vi.mock('@/db', () => ({ db: { query: { coffeePages: { findFirst: mocks.findFirstMock } } } }));
vi.mock('@/lib/auth/authenticate', () => ({ authenticate: mocks.authenticateMock }));

import { GET } from '../route';

const request = new Request('https://coffee.test/api/pages/mine') as Parameters<typeof GET>[0];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authenticateMock.mockResolvedValue({ auth: { did: 'did:imajin:creator', scopes: [], via: 'token' } });
});

describe('GET /api/pages/mine', () => {
  it('authenticates through the app-token adapter and returns 401 on failure', async () => {
    mocks.authenticateMock.mockResolvedValue({ error: 'Authorization required', status: 401 });

    const res = await GET(request);

    expect(mocks.authenticateMock).toHaveBeenCalledWith(request);
    expect(res.status).toBe(401);
    expect(mocks.findFirstMock).not.toHaveBeenCalled();
  });

  it("returns the caller's page", async () => {
    mocks.findFirstMock.mockResolvedValue({ id: 'page_1', did: 'did:imajin:creator', handle: 'creator' });

    const res = await GET(request);

    expect(res.status).toBe(200);
    expect((await res.json()).handle).toBe('creator');
  });

  it('returns 404 when the caller has no page', async () => {
    mocks.findFirstMock.mockResolvedValue(undefined);

    const res = await GET(request);

    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('No coffee page found');
  });

  it('returns 500 when the lookup fails', async () => {
    mocks.findFirstMock.mockRejectedValue(new Error('db down'));

    expect((await GET(request)).status).toBe(500);
  });
});
