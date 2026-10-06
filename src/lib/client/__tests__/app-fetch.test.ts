import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appFetch, resetAppTokenCache } from '../app-fetch';

const fetchMock = vi.fn();

function mintResponse(body: unknown, ok = true) {
  return { ok, json: async () => body };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetAppTokenCache();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('NEXT_PUBLIC_IMAJIN_AUTH_URL', 'https://kernel.test');
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://coffee.test');
  vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('appFetch', () => {
  it("mints a token for this app's host and sends it as a Bearer credential", async () => {
    fetchMock
      .mockResolvedValueOnce(mintResponse({ token: 'tok-1', expiresIn: 600 }))
      .mockResolvedValueOnce({ ok: true });

    await appFetch('/api/pages/mine', { headers: { Accept: 'application/json' } });

    const [mintUrl, mintInit] = fetchMock.mock.calls[0];
    expect(mintUrl).toBe('https://kernel.test/auth/api/tokens/app');
    expect(mintInit.method).toBe('POST');
    expect(JSON.parse(mintInit.body)).toEqual({ aud: 'coffee.test', scopes: [] });

    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe('/api/pages/mine');
    expect(init.credentials).toBe('include');
    expect(init.headers.get('Authorization')).toBe('Bearer tok-1');
    expect(init.headers.get('Accept')).toBe('application/json');
  });

  it('prefixes the basePath and reuses a cached token until it nears expiry', async () => {
    vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '/coffee');
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(mintResponse({ token: 'tok-1', expiresIn: 600 }))
      .mockResolvedValue({ ok: true });

    await appFetch('/api/a');
    await appFetch('/api/b');

    expect(fetchMock).toHaveBeenCalledTimes(3); // one mint, two calls
    expect(fetchMock.mock.calls[2][0]).toBe('/coffee/api/b');

    vi.advanceTimersByTime(600_000);
    fetchMock.mockResolvedValueOnce(mintResponse({ token: 'tok-2', expiresIn: 600 }));
    await appFetch('/api/c');

    expect(fetchMock.mock.calls[4][1].headers.get('Authorization')).toBe('Bearer tok-2');
  });

  it('still sends the request (cookie fallback) when the mint is refused', async () => {
    fetchMock.mockResolvedValueOnce(mintResponse({}, false)).mockResolvedValueOnce({ ok: true });

    await appFetch('/api/pages/mine');

    const init = fetchMock.mock.calls[1][1];
    expect(init.headers.has('Authorization')).toBe(false);
    expect(init.credentials).toBe('include');
  });

  it('still sends the request when the mint call throws', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce({ ok: true });

    await appFetch('/api/pages/mine');

    expect(fetchMock.mock.calls[1][1].headers.has('Authorization')).toBe(false);
  });

  it('skips minting entirely when no kernel auth URL is configured', async () => {
    vi.stubEnv('NEXT_PUBLIC_IMAJIN_AUTH_URL', '');
    fetchMock.mockResolvedValueOnce({ ok: true });

    await appFetch('/api/pages/mine');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
