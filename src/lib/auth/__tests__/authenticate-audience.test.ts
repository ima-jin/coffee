import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Drives the real @ima-jin/auth verification (only the network is stubbed) to
// pin the #2706 contract: the audience sent to the kernel is coffee's registry
// slug, never the host the request arrived on.
vi.mock('@ima-jin/auth-client', () => ({ getSession: vi.fn().mockResolvedValue(null) }));
vi.mock('@/lib/auth-config', () => ({ authConfig: { secret: 'test-secret' } }));

import { authenticate } from '../authenticate';

const fetchMock = vi.fn();
const request = new Request('https://jin.imajin.ai/coffee/api/pages/mine', {
  headers: { Authorization: 'Bearer scoped-token' },
});

function verifiedAs(sub: string) {
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ sub, aud: 'coffee', scopes: [] }) });
}

function verifiedAudience(): unknown {
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe('https://kernel.test/auth/api/tokens/app/verify');
  return JSON.parse(init.body).aud;
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('AUTH_SERVICE_URL', 'https://kernel.test/auth');
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://jin.imajin.ai');
  vi.stubEnv('IMAJIN_APP_AUD', '');
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('authenticate — app-token audience (#2706)', () => {
  it('verifies against the slug `coffee` even though the shared host differs', async () => {
    verifiedAs('did:imajin:alice');

    const result = await authenticate(request);

    expect(verifiedAudience()).toBe('coffee');
    expect(result).toEqual({ auth: { did: 'did:imajin:alice', scopes: [], via: 'token' } });
  });

  it('honours IMAJIN_APP_AUD as an operator override', async () => {
    vi.stubEnv('IMAJIN_APP_AUD', 'coffee-dev');
    verifiedAs('did:imajin:alice');

    await authenticate(request);

    expect(verifiedAudience()).toBe('coffee-dev');
  });

  it('rejects a host-shaped IMAJIN_APP_AUD without calling the kernel', async () => {
    vi.stubEnv('IMAJIN_APP_AUD', 'jin.imajin.ai');

    const result = await authenticate(request);

    expect(result).toEqual({ error: 'App audience is misconfigured', status: 500 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a token the kernel refuses for this audience', async () => {
    fetchMock.mockResolvedValue({ ok: false });

    const result = await authenticate(request);

    expect(result).toEqual({ error: 'Invalid or expired app token for this app', status: 401 });
  });
});
