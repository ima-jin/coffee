import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const { readKeystoreMock, resolveKeystorePathMock } = vi.hoisted(() => ({
  readKeystoreMock: vi.fn(),
  resolveKeystorePathMock: vi.fn(() => '/tmp/keystore.json'),
}));

vi.mock('@ima-jin/auth-client', async (importOriginal) => ({
  ...await importOriginal<typeof import('@ima-jin/auth-client')>(),
  readKeystore: readKeystoreMock,
  resolveKeystorePath: resolveKeystorePathMock,
}));

/** Runs the middleware for `path` with the given claim state, mocking only the on-disk keystore check. */
async function middlewareFor(path: string, options: { claimed: boolean }): Promise<NextResponse> {
  readKeystoreMock.mockReturnValue(options.claimed ? { publicKey: 'pub', privateKey: 'priv' } : null);
  const { middleware } = await import('../middleware');
  return middleware(new NextRequest(new URL(path, 'http://localhost:3000')));
}

describe('middleware', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_KERNEL_URL', 'https://jin.imajin.ai');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    readKeystoreMock.mockReset();
    resolveKeystorePathMock.mockClear();
  });

  it('serves the "not claimed yet" page for an ordinary route when unclaimed', async () => {
    const response = await middlewareFor('/', { claimed: false });

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text.toLowerCase()).toContain('not claimed yet');
  });

  it('passes /claim through when unclaimed', async () => {
    const response = await middlewareFor('/claim', { claimed: false });

    expect(response.headers.get('x-middleware-next')).toBe('1');
  });

  it('passes /api/health and /api/claim through when unclaimed', async () => {
    expect((await middlewareFor('/api/health', { claimed: false })).headers.get('x-middleware-next')).toBe('1');
    expect((await middlewareFor('/api/claim', { claimed: false })).headers.get('x-middleware-next')).toBe('1');
  });

  it('404s /claim once claimed', async () => {
    const response = await middlewareFor('/claim', { claimed: true });

    expect(response.status).toBe(404);
  });

  it('404s /api/claim once claimed', async () => {
    const response = await middlewareFor('/api/claim', { claimed: true });

    expect(response.status).toBe(404);
  });

  it('passes ordinary routes through once claimed', async () => {
    const response = await middlewareFor('/', { claimed: true });

    expect(response.headers.get('x-middleware-next')).toBe('1');
  });

  it('does not serve the dashboard redirect or API CORS while unclaimed', async () => {
    const dashboard = await middlewareFor('/dashboard', { claimed: false });
    expect(dashboard.headers.get('location')).toBeNull();
    expect((await dashboard.text()).toLowerCase()).toContain('not claimed yet');
  });
});

describe.each([false, true])('root auth callback forwarding (claimed: %s)', (claimed) => {
  afterEach(() => {
    vi.unstubAllEnvs();
    readKeystoreMock.mockReset();
    resolveKeystorePathMock.mockClear();
  });

  it.each([
    { basePath: '', root: '/' },
    { basePath: '/coffee', root: '/coffee' },
    { basePath: '/coffee', root: '/coffee/' },
  ])('forwards the $root root before reading the keystore', async ({ basePath, root }) => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', `https://app.example${basePath}`);
    const { middleware } = await import('../middleware');
    readKeystoreMock.mockReturnValue(claimed ? {} : null);
    const query = '?attestation_id=test-attestation&user_did=did%3Aimajin%3Aalice&state=preserved';
    const request = new NextRequest(`https://app.example${root}${query}`, {
      nextConfig: { basePath },
    });

    const response = middleware(request);

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(`https://app.example${basePath}/api/auth/callback${query}`);
    expect(readKeystoreMock).not.toHaveBeenCalled();
    expect(resolveKeystorePathMock).not.toHaveBeenCalled();
  });
  it('uses the Next.js basePath when no public URL is configured', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '');
    const { middleware } = await import('../middleware');
    readKeystoreMock.mockReturnValue(claimed ? {} : null);
    const query = '?attestation_id=test-attestation&user_did=did%3Aimajin%3Aalice';
    const response = middleware(new NextRequest(`https://app.example/coffee${query}`, {
      nextConfig: { basePath: '/coffee' },
    }));

    expect(response.headers.get('location')).toBe(`https://app.example/coffee/api/auth/callback${query}`);
    expect(readKeystoreMock).not.toHaveBeenCalled();
  });

  it.each(['', '?attestation_id=test-attestation', '?user_did=did:imajin:alice', '?attestation_id=&user_did=did:imajin:alice'])(
    'keeps the existing root behavior without complete callback params: %s',
    async (query) => {
      vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.example/coffee');
      const { middleware } = await import('../middleware');
      readKeystoreMock.mockReturnValue(claimed ? {} : null);
      const response = middleware(new NextRequest(`https://app.example/coffee${query}`, {
        nextConfig: { basePath: '/coffee' },
      }));

      expect(response.headers.get('location')).toBeNull();
      expect(readKeystoreMock).toHaveBeenCalledOnce();
      if (claimed) {
        expect(response.headers.get('x-middleware-next')).toBe('1');
      } else {
        expect(await response.text()).toContain('Not claimed yet');
      }
    },
  );

  it('does not forward callback params on a non-root page', async () => {
    const response = await middlewareFor('/other?attestation_id=test-attestation&user_did=did:imajin:alice', { claimed });

    expect(response.headers.get('location')).toBeNull();
    expect(readKeystoreMock).toHaveBeenCalledOnce();
  });
});

describe('coffee middleware — standalone dashboard redirect (#2332), once claimed', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_KERNEL_URL', 'https://jin.imajin.ai');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    readKeystoreMock.mockReset();
    resolveKeystorePathMock.mockClear();
  });

  async function claimedRequest(url: string, init?: ConstructorParameters<typeof NextRequest>[1]): Promise<NextResponse> {
    readKeystoreMock.mockReturnValue({ publicKey: 'pub', privateKey: 'priv' });
    const { middleware } = await import('../middleware');
    return middleware(new NextRequest(url, init));
  }

  it('308-redirects the standalone /dashboard route to its hub tab, preserving the query string', async () => {
    const res = await claimedRequest('https://coffee.imajin.ai/dashboard?foo=bar');

    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe('https://jin.imajin.ai/auth/coffee?foo=bar');
  });

  it('lets the hub embed load of /dashboard through without redirecting', async () => {
    const res = await claimedRequest('https://coffee.imajin.ai/dashboard?embed=hub&did=did:imajin:x');

    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('x-middleware-next')).toBe('1');
  });

  it('answers CORS preflights on the API without redirecting', async () => {
    const res = await claimedRequest('https://coffee.imajin.ai/api/tip', {
      method: 'OPTIONS',
      headers: { origin: 'https://imajin.ai' },
    });

    expect(res.status).toBe(204);
  });

  it('passes API requests through', async () => {
    const res = await claimedRequest('https://coffee.imajin.ai/api/health');

    expect(res.headers.get('location')).toBeNull();
    expect(res.status).toBe(200);
  });

  it('does not apply the CORS pass-through to ordinary pages', async () => {
    const res = await claimedRequest('https://coffee.imajin.ai/', { headers: { origin: 'https://imajin.ai' } });

    expect(res.headers.get('x-middleware-next')).toBe('1');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});
