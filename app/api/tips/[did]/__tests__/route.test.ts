import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const groupByMock = vi.fn();
  const whereMock = vi.fn(() => ({ groupBy: groupByMock }));
  const fromMock = vi.fn(() => ({ where: whereMock }));
  return {
    groupByMock,
    whereMock,
    selectMock: vi.fn(() => ({ from: fromMock })),
    findPageMock: vi.fn(),
    findTipsMock: vi.fn(),
    authenticateMock: vi.fn(),
  };
});

vi.mock('@ima-jin/logger', () => ({ createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) }));
vi.mock('drizzle-orm', () => ({
  eq: vi.fn((column: unknown, value: unknown) => ({ column, value })),
  sql: vi.fn(() => 'sql'),
}));
vi.mock('@/db', () => ({
  db: {
    query: { coffeePages: { findFirst: mocks.findPageMock }, tips: { findMany: mocks.findTipsMock } },
    select: mocks.selectMock,
  },
  tips: { currency: 'currency', amount: 'amount', pageId: 'page_id' },
}));
vi.mock('@/lib/auth/authenticate', () => ({ authenticate: mocks.authenticateMock }));

import { GET } from '../route';

const DID = 'did:imajin:creator';
const PROPS = { params: Promise.resolve({ did: DID }) };

function makeRequest(query = ''): Parameters<typeof GET>[0] {
  const request = new Request(`https://coffee.test/api/tips/${DID}${query}`) as Parameters<typeof GET>[0];
  Object.defineProperty(request, 'nextUrl', { value: new URL(request.url) });
  return request;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authenticateMock.mockResolvedValue({ auth: { did: DID, scopes: [], via: 'token' } });
  mocks.findPageMock.mockResolvedValue({ id: 'page_1', did: DID });
  mocks.findTipsMock.mockResolvedValue([{ id: 'tip_1' }]);
  mocks.groupByMock.mockResolvedValue([
    { currency: 'USD', total: '1500', count: '3' },
    { currency: 'SOL', total: 2, count: 1 },
  ]);
});

describe('GET /api/tips/:did', () => {
  it('requires authentication', async () => {
    mocks.authenticateMock.mockResolvedValue({ error: 'Authorization required', status: 401 });

    expect((await GET(makeRequest(), PROPS)).status).toBe(401);
  });

  it("refuses to show another DID's tips", async () => {
    mocks.authenticateMock.mockResolvedValue({ auth: { did: 'did:imajin:other', scopes: [], via: 'token' } });

    const res = await GET(makeRequest(), PROPS);

    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('Not authorized to view these tips');
    expect(mocks.findPageMock).not.toHaveBeenCalled();
  });

  it('returns 404 when the DID has no page', async () => {
    mocks.findPageMock.mockResolvedValue(undefined);

    const res = await GET(makeRequest(), PROPS);

    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('No coffee page found for this DID');
  });

  it('returns tips, per-currency totals and default pagination', async () => {
    const res = await GET(makeRequest(), PROPS);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      tips: [{ id: 'tip_1' }],
      totals: { USD: { total: 1500, count: 3 }, SOL: { total: 2, count: 1 } },
      pagination: { limit: 50, offset: 0 },
    });
    expect(mocks.findTipsMock).toHaveBeenCalledWith(expect.objectContaining({ limit: 50, offset: 0 }));
  });

  it('caps the limit at 100 and honours offset', async () => {
    const res = await GET(makeRequest('?limit=500&offset=20'), PROPS);

    expect((await res.json()).pagination).toEqual({ limit: 100, offset: 20 });
  });

  it('builds the where/orderBy clauses, filtering by status when given', async () => {
    await GET(makeRequest('?status=completed'), PROPS);

    const { where, orderBy } = mocks.findTipsMock.mock.calls[0][0];
    const eq = vi.fn((column: string, value: string) => ({ column, value }));
    const and = vi.fn((...conditions: unknown[]) => conditions);
    const desc = vi.fn((column: string) => ({ desc: column }));
    const columns = { pageId: 'pageId', status: 'status', createdAt: 'createdAt' };

    expect(where(columns, { eq, and })).toEqual([
      { column: 'pageId', value: 'page_1' },
      { column: 'status', value: 'completed' },
    ]);
    expect(orderBy(columns, { desc })).toEqual([{ desc: 'createdAt' }]);
  });

  it('does not add a status condition when none was requested', async () => {
    await GET(makeRequest(), PROPS);

    const { where } = mocks.findTipsMock.mock.calls[0][0];
    const and = vi.fn((...conditions: unknown[]) => conditions);

    expect(where({ pageId: 'pageId', status: 'status' }, { eq: (c: string, v: string) => ({ c, v }), and })).toHaveLength(1);
  });

  it('returns 500 when the query fails', async () => {
    mocks.findTipsMock.mockRejectedValue(new Error('db down'));

    expect((await GET(makeRequest(), PROPS)).status).toBe(500);
  });
});
