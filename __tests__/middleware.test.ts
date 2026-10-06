import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { config, middleware } from '../middleware';

describe('coffee middleware — standalone dashboard redirect (#2332)', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_KERNEL_URL', 'https://jin.imajin.ai');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('308-redirects the standalone /dashboard route to its hub tab, preserving the query string', () => {
    const res = middleware(new NextRequest('https://coffee.imajin.ai/dashboard?foo=bar'));

    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe('https://jin.imajin.ai/auth/coffee?foo=bar');
  });

  it('answers CORS preflights on the API without redirecting', () => {
    const res = middleware(
      new NextRequest('https://coffee.imajin.ai/api/tip', {
        method: 'OPTIONS',
        headers: { origin: 'https://imajin.ai' },
      }),
    );

    expect(res.status).toBe(204);
  });

  it('passes API requests through', () => {
    const res = middleware(new NextRequest('https://coffee.imajin.ai/api/health'));

    expect(res.headers.get('location')).toBeNull();
    expect(res.status).toBe(200);
  });

  it('matches the API and only the /dashboard requests that are not the hub embed', () => {
    const matchers = config.matcher as Array<string | { source: string; missing?: unknown }>;
    const dashboardMatcher = matchers.find(
      (m): m is { source: string; missing?: unknown } => typeof m === 'object' && m.source === '/dashboard',
    );

    expect(matchers).toContain('/api/:path*');
    expect(dashboardMatcher?.missing).toEqual([{ type: 'query', key: 'embed' }]);
  });
});
