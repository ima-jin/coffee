import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const returningMock = vi.fn();
  const whereUpdateMock = vi.fn(() => ({ returning: returningMock }));
  const setMock = vi.fn((values: Record<string, unknown>) => ({ where: whereUpdateMock, values }));
  const whereDeleteMock = vi.fn();
  return {
    returningMock,
    setMock,
    whereUpdateMock,
    whereDeleteMock,
    updateMock: vi.fn(() => ({ set: setMock })),
    deleteMock: vi.fn(() => ({ where: whereDeleteMock })),
    findFirstMock: vi.fn(),
    authenticateMock: vi.fn(),
  };
});

vi.mock('@ima-jin/logger', () => ({ createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) }));
vi.mock('drizzle-orm', () => ({ eq: vi.fn((column: unknown, value: unknown) => ({ column, value })) }));
vi.mock('@/db', () => ({
  db: {
    query: { coffeePages: { findFirst: mocks.findFirstMock } },
    update: mocks.updateMock,
    delete: mocks.deleteMock,
  },
  coffeePages: { id: 'id-column' },
}));
vi.mock('@/lib/auth/authenticate', () => ({ authenticate: mocks.authenticateMock }));

import { DELETE, GET, PUT } from '../route';

const PROPS = { params: Promise.resolve({ handle: 'creator' }) };
const PAGE = { id: 'page_1', did: 'did:imajin:creator', handle: 'creator', isPublic: true, title: 'Creator' };

function makeRequest(method: string, body?: unknown): Parameters<typeof PUT>[0] {
  return new Request('https://coffee.test/api/pages/creator', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }) as Parameters<typeof PUT>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authenticateMock.mockResolvedValue({ auth: { did: 'did:imajin:creator', scopes: [], via: 'token' } });
  mocks.findFirstMock.mockResolvedValue(PAGE);
  mocks.returningMock.mockResolvedValue([{ ...PAGE, title: 'Updated' }]);
  mocks.whereDeleteMock.mockResolvedValue(undefined);
});

describe('GET /api/pages/:handle', () => {
  it('returns a public page without authentication', async () => {
    const res = await GET(makeRequest('GET'), PROPS);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(PAGE);
    expect(mocks.authenticateMock).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown handle', async () => {
    mocks.findFirstMock.mockResolvedValue(undefined);

    expect((await GET(makeRequest('GET'), PROPS)).status).toBe(404);
  });

  it('returns 403 for a private page', async () => {
    mocks.findFirstMock.mockResolvedValue({ ...PAGE, isPublic: false });

    const res = await GET(makeRequest('GET'), PROPS);

    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('This page is private');
  });

  it('returns 500 when the lookup fails', async () => {
    mocks.findFirstMock.mockRejectedValue(new Error('db down'));

    expect((await GET(makeRequest('GET'), PROPS)).status).toBe(500);
  });
});

describe('PUT /api/pages/:handle', () => {
  it('requires authentication', async () => {
    mocks.authenticateMock.mockResolvedValue({ error: 'Authorization required', status: 401 });

    expect((await PUT(makeRequest('PUT', {}), PROPS)).status).toBe(401);
  });

  it('returns 404 for an unknown handle', async () => {
    mocks.findFirstMock.mockResolvedValue(undefined);

    expect((await PUT(makeRequest('PUT', {}), PROPS)).status).toBe(404);
  });

  it('returns 403 when the caller does not own the page', async () => {
    mocks.authenticateMock.mockResolvedValue({ auth: { did: 'did:imajin:other', scopes: [], via: 'token' } });

    const res = await PUT(makeRequest('PUT', { title: 'x' }), PROPS);

    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('Not authorized to update this page');
    expect(mocks.updateMock).not.toHaveBeenCalled();
  });

  it('applies only the supplied fields (plus updatedAt)', async () => {
    const res = await PUT(makeRequest('PUT', { title: 'Updated', isPublic: false, thankYouContent: '' }), PROPS);

    expect(res.status).toBe(200);
    expect((await res.json()).title).toBe('Updated');
    const [updates] = mocks.setMock.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(Object.keys(updates).sort()).toEqual(['isPublic', 'thankYouContent', 'title', 'updatedAt']);
    expect(updates.thankYouContent).toBeNull();
    expect(updates.updatedAt).toBeInstanceOf(Date);
    expect(mocks.whereUpdateMock).toHaveBeenCalledWith({ column: 'id-column', value: 'page_1' });
  });

  it('maps every updatable field', async () => {
    const body = {
      title: 'T',
      bio: 'B',
      avatar: 'A',
      avatarAssetId: 'asset',
      theme: { a: 1 },
      paymentMethods: { stripe: { enabled: true } },
      presets: [100],
      allowCustomAmount: false,
      allowMessages: false,
      isPublic: true,
      thankYouContent: 'thanks',
    };

    await PUT(makeRequest('PUT', body), PROPS);

    expect(mocks.setMock.mock.calls[0][0]).toMatchObject(body);
  });

  it('returns 500 when the update fails', async () => {
    mocks.returningMock.mockRejectedValue(new Error('db down'));

    expect((await PUT(makeRequest('PUT', { title: 'x' }), PROPS)).status).toBe(500);
  });
});

describe('DELETE /api/pages/:handle', () => {
  it('requires authentication', async () => {
    mocks.authenticateMock.mockResolvedValue({ error: 'Authorization required', status: 401 });

    expect((await DELETE(makeRequest('DELETE'), PROPS)).status).toBe(401);
  });

  it('returns 404 for an unknown handle', async () => {
    mocks.findFirstMock.mockResolvedValue(undefined);

    expect((await DELETE(makeRequest('DELETE'), PROPS)).status).toBe(404);
  });

  it('returns 403 when the caller does not own the page', async () => {
    mocks.authenticateMock.mockResolvedValue({ auth: { did: 'did:imajin:other', scopes: [], via: 'token' } });

    const res = await DELETE(makeRequest('DELETE'), PROPS);

    expect(res.status).toBe(403);
    expect(mocks.deleteMock).not.toHaveBeenCalled();
  });

  it('deletes the owner’s page', async () => {
    const res = await DELETE(makeRequest('DELETE'), PROPS);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    expect(mocks.whereDeleteMock).toHaveBeenCalledWith({ column: 'id-column', value: 'page_1' });
  });

  it('returns 500 when the delete fails', async () => {
    mocks.whereDeleteMock.mockRejectedValue(new Error('db down'));

    expect((await DELETE(makeRequest('DELETE'), PROPS)).status).toBe(500);
  });
});
