import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock('@ima-jin/logger', () => ({ createLogger: () => mocks.log }));

import { settleTip } from '../settle';

const PARAMS = {
  tipId: 'tip_1',
  recipientDid: 'did:imajin:creator',
  fromDid: 'did:imajin:fan',
  amount: 1000,
  currency: 'USD',
  stripeSessionId: 'cs_1',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', mocks.fetchMock);
  vi.stubEnv('PAY_SERVICE_URL', 'https://kernel.test/pay');
  vi.stubEnv('PAY_SERVICE_API_KEY', 'service-key');
  vi.stubEnv('PLATFORM_DID', '');
  vi.stubEnv('PLATFORM_FEE_PERCENT', '');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('settleTip', () => {
  it('posts the .fair chain (creator + 1.5% platform fee) to the pay service', async () => {
    mocks.fetchMock.mockResolvedValue({ ok: true, json: async () => ({ settled: true }) });

    await settleTip(PARAMS);

    const [url, init] = mocks.fetchMock.mock.calls[0];
    expect(url).toBe('https://kernel.test/pay/api/settle');
    expect(init.headers.Authorization).toBe('Bearer service-key');
    expect(JSON.parse(init.body)).toEqual({
      from_did: 'did:imajin:fan',
      total_amount: 10,
      service: 'coffee',
      type: 'tip',
      funded: true,
      funded_provider: 'stripe',
      fair_manifest: {
        chain: [
          { did: 'did:imajin:creator', amount: 9.85, role: 'creator' },
          { did: 'did:imajin:platform', amount: 0.15, role: 'platform' },
        ],
      },
      metadata: { tipId: 'tip_1', stripeSessionId: 'cs_1' },
    });
    expect(mocks.log.info).toHaveBeenCalled();
  });

  it('honours PLATFORM_DID / PLATFORM_FEE_PERCENT and labels anonymous senders', async () => {
    vi.stubEnv('PLATFORM_DID', 'did:imajin:node');
    vi.stubEnv('PLATFORM_FEE_PERCENT', '10');
    mocks.fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });

    await settleTip({ ...PARAMS, fromDid: null, stripeSessionId: undefined });

    const body = JSON.parse(mocks.fetchMock.mock.calls[0][1].body);
    expect(body.from_did).toBe('anonymous');
    expect(body.metadata).toEqual({ tipId: 'tip_1' });
    expect(body.fair_manifest.chain).toEqual([
      { did: 'did:imajin:creator', amount: 9, role: 'creator' },
      { did: 'did:imajin:node', amount: 1, role: 'platform' },
    ]);
  });

  it('skips settlement (non-fatal) when no service key is configured', async () => {
    vi.stubEnv('PAY_SERVICE_API_KEY', '');

    await settleTip(PARAMS);

    expect(mocks.fetchMock).not.toHaveBeenCalled();
    expect(mocks.log.error).toHaveBeenCalled();
  });

  it('logs and swallows a non-OK response', async () => {
    mocks.fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' });

    await expect(settleTip(PARAMS)).resolves.toBeUndefined();

    expect(mocks.log.error).toHaveBeenCalledWith({ status: 500, text: 'boom' }, expect.any(String));
  });

  it('logs and swallows a network failure', async () => {
    mocks.fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(settleTip(PARAMS)).resolves.toBeUndefined();

    expect(mocks.log.error).toHaveBeenCalled();
  });
});
