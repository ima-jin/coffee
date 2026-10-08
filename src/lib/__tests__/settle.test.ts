import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  getAppServiceTokenMock: vi.fn(),
  resetTokenMock: vi.fn(),
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock('@ima-jin/logger', () => ({ createLogger: () => mocks.log }));
vi.mock('@/lib/app-service-token', () => ({
  AppServiceTokenError: class AppServiceTokenError extends Error {},
  getAppServiceToken: mocks.getAppServiceTokenMock,
  resetAppServiceTokenCache: mocks.resetTokenMock,
}));

import { settleTip } from '../settle';

const MANIFEST = {
  chain: [
    { did: 'did:imajin:creator', role: 'creator', amount: 9.85 },
    { did: 'did:imajin:platform', role: 'platform', amount: 0.15 },
  ],
};

const PARAMS = { tipId: 'tip_1', payTransactionId: 'tx_1', manifest: MANIFEST };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', mocks.fetchMock);
  vi.stubEnv('PAY_SERVICE_URL', 'https://kernel.test/pay');
  mocks.getAppServiceTokenMock.mockResolvedValue('app-service-token');
  mocks.fetchMock.mockImplementation(async () => jsonResponse(200, { settled: true }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('settleTip', () => {
  it('posts { transaction_id, fair_manifest: { chain } } with the app-service token — and nothing else', async () => {
    const outcome = await settleTip(PARAMS);

    expect(outcome).toBe('settled');
    const [url, init] = mocks.fetchMock.mock.calls[0];
    expect(url).toBe('https://kernel.test/pay/api/settle');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer app-service-token');
    expect(JSON.parse(init.body)).toEqual({ transaction_id: 'tx_1', fair_manifest: { chain: MANIFEST.chain } });
    expect(mocks.log.info).toHaveBeenCalled();
  });

  it('never posts from_did / total_amount — the payer is recorded as anonymous by the kernel', async () => {
    await settleTip(PARAMS);

    const body = JSON.parse(mocks.fetchMock.mock.calls[0][1].body);
    expect(body).not.toHaveProperty('from_did');
    expect(body).not.toHaveProperty('total_amount');
  });

  it('treats alreadySettled: true as success (retries are safe)', async () => {
    mocks.fetchMock.mockImplementation(async () => jsonResponse(200, { settled: true, alreadySettled: true }));

    expect(await settleTip(PARAMS)).toBe('already-settled');
    expect(mocks.log.error).not.toHaveBeenCalled();
  });

  it('reports 409 (payment not completed yet) as not-completed, without an error log', async () => {
    mocks.fetchMock.mockImplementation(async () => jsonResponse(409, { error: "Payment is not paid yet (status 'pending')" }));

    expect(await settleTip(PARAMS)).toBe('not-completed');
    expect(mocks.log.warn).toHaveBeenCalled();
    expect(mocks.log.error).not.toHaveBeenCalled();
  });

  it('reports 403 (manifest mismatch / payment of another app) as rejected and logs it', async () => {
    mocks.fetchMock.mockImplementation(async () =>
      jsonResponse(403, { error: 'fair_manifest does not match the recorded payee manifest' })
    );

    expect(await settleTip(PARAMS)).toBe('rejected');
    expect(mocks.log.error).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }), expect.any(String));
    expect(mocks.resetTokenMock).not.toHaveBeenCalled();
  });

  it('drops the cached token on 401 so the next attempt mints a fresh one', async () => {
    mocks.fetchMock.mockImplementation(async () => jsonResponse(401, { error: 'Unauthorized' }));

    expect(await settleTip(PARAMS)).toBe('rejected');
    expect(mocks.resetTokenMock).toHaveBeenCalledTimes(1);
  });

  it('reports a 5xx as a transient failure', async () => {
    mocks.fetchMock.mockImplementation(async () => jsonResponse(500, { error: 'Settlement failed' }));

    expect(await settleTip(PARAMS)).toBe('failed');
  });

  it('reports a network failure as failed (non-fatal)', async () => {
    mocks.fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    expect(await settleTip(PARAMS)).toBe('failed');
    expect(mocks.log.error).toHaveBeenCalled();
  });

  it('does not call pay when the app-service token cannot be minted', async () => {
    mocks.getAppServiceTokenMock.mockRejectedValue(new Error('mint refused'));

    expect(await settleTip(PARAMS)).toBe('failed');
    expect(mocks.fetchMock).not.toHaveBeenCalled();
    expect(mocks.log.error).toHaveBeenCalled();
  });
});
