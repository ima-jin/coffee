import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { cookieGet } = vi.hoisted(() => ({ cookieGet: vi.fn() }));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: cookieGet }),
}));
vi.mock('@/lib/self-secrets', () => ({ sessionSecret: () => 'test-secret' }));
vi.mock('@ima-jin/auth-client', async (importOriginal) => ({
  ...await importOriginal<typeof import('@ima-jin/auth-client')>(),
  readKeystore: () => ({}),
  resolveKeystorePath: () => '/unused-test-keystore',
}));

function request(path: string): NextRequest {
  return new NextRequest(`https://app.example/coffee${path}`, {
    nextConfig: { basePath: '/coffee' },
  });
}

describe('standalone sign-in callback flow', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.example/coffee');
    vi.stubEnv('IMAJIN_AUTH_URL', 'https://kernel.example');
    cookieGet.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('forwards to the existing callback, sets a readable session, and lands without another login redirect', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      did: 'did:imajin:alice',
      displayName: 'Alice',
      handle: 'alice',
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { middleware } = await import('../../../../../middleware');
    const { GET: callback } = await import('../route');
    const { GET: session } = await import('../../session/route');
    const query = '?attestation_id=test-attestation&user_did=did%3Aimajin%3Aalice';

    const forwarded = middleware(request(`/${query}`));
    const callbackUrl = new URL(forwarded.headers.get('location')!);
    expect(callbackUrl.pathname).toBe('/coffee/api/auth/callback');
    const callbackRequest = request(`/api/auth/callback${callbackUrl.search}`);
    expect(middleware(callbackRequest).headers.get('x-middleware-next')).toBe('1');
    const response = await callback(callbackRequest);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://kernel.example/profile/api/profile/did%3Aimajin%3Aalice',
      { headers: { 'Content-Type': 'application/json' } },
    );
    const cookie = response.cookies.get('imajin_session');
    expect(cookie?.value).toBeTruthy();
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
    expect(response.headers.get('set-cookie')).toContain('SameSite=lax');
    cookieGet.mockReturnValue(cookie);
    expect(await (await session()).json()).toMatchObject({
      did: 'did:imajin:alice',
      attestationId: 'test-attestation',
    });

    expect(response.headers.get('location')).toBe('https://app.example/coffee/');
    const landing = middleware(request('/'));
    expect(landing.headers.get('location')).toBeNull();
    expect(landing.headers.get('x-middleware-next')).toBe('1');
  });

  it('keeps missing-parameter errors inside the app basePath', async () => {
    const { GET } = await import('../route');

    const response = await GET(request('/api/auth/callback'));

    expect(response.headers.get('location')).toBe('https://app.example/coffee/?auth_error=missing_params');
    expect(response.cookies.get('imajin_session')).toBeUndefined();
  });

  it('keeps logout inside the app basePath and clears the session', async () => {
    const { POST } = await import('../../logout/route');

    const response = await POST(request('/api/auth/logout'));

    expect(response.headers.get('location')).toBe('https://app.example/coffee/');
    expect(response.cookies.get('imajin_session')?.value).toBe('');
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });
});
