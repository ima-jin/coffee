import { afterEach, describe, expect, it, vi } from 'vitest';
import { payServiceUrl, publicAppUrl, thisAppHost, webhookSecret } from '../env';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('payServiceUrl', () => {
  it('returns PAY_SERVICE_URL without trailing slashes', () => {
    vi.stubEnv('PAY_SERVICE_URL', 'https://kernel.test/pay//');

    expect(payServiceUrl()).toBe('https://kernel.test/pay');
  });

  it('throws when PAY_SERVICE_URL is unset', () => {
    vi.stubEnv('PAY_SERVICE_URL', '');

    expect(() => payServiceUrl()).toThrow('PAY_SERVICE_URL is not set');
  });
});

describe('webhookSecret', () => {
  it('returns the configured secret', () => {
    vi.stubEnv('WEBHOOK_SECRET', 's3cret');

    expect(webhookSecret()).toBe('s3cret');
  });

  it('returns undefined when unset or empty', () => {
    vi.stubEnv('WEBHOOK_SECRET', '');

    expect(webhookSecret()).toBeUndefined();
  });
});

describe('thisAppHost', () => {
  it("derives the host from NEXT_PUBLIC_APP_URL (the token audience)", () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://dev-coffee.imajin.ai:8443/path');

    expect(thisAppHost()).toBe('dev-coffee.imajin.ai:8443');
  });

  it('falls back to the production host when unset', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '');

    expect(thisAppHost()).toBe('coffee.imajin.ai');
  });

  it('falls back to the production host when the URL is malformed', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'not a url');

    expect(thisAppHost()).toBe('coffee.imajin.ai');
  });
});

describe('publicAppUrl', () => {
  it('joins the origin and basePath', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://coffee.test/');
    vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '/coffee');

    expect(publicAppUrl()).toBe('https://coffee.test/coffee');
  });

  it('is just the origin without a basePath', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://coffee.test');
    vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '');

    expect(publicAppUrl()).toBe('https://coffee.test');
  });

  it('throws when NEXT_PUBLIC_APP_URL is unset', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '');

    expect(() => publicAppUrl()).toThrow('NEXT_PUBLIC_APP_URL is not set');
  });
});
