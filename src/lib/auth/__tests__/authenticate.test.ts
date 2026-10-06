import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireSessionOrAppTokenMock: vi.fn(),
  getSessionMock: vi.fn(),
}));

vi.mock('@ima-jin/auth', () => ({ requireSessionOrAppToken: mocks.requireSessionOrAppTokenMock }));
vi.mock('@ima-jin/auth-client', () => ({ getSession: mocks.getSessionMock }));
vi.mock('@/lib/auth-config', () => ({ authConfig: { secret: 'test-secret' } }));

import { authenticate, optionalCallerDid } from '../authenticate';

const request = new Request('https://coffee.imajin.ai/api/pages/mine');

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://coffee.imajin.ai');
  mocks.getSessionMock.mockResolvedValue(null);
});

describe('authenticate', () => {
  it("verifies scoped app tokens against this app's own host as the audience", async () => {
    mocks.requireSessionOrAppTokenMock.mockResolvedValue({
      auth: { did: 'did:imajin:alice', scopes: ['profile:read'], via: 'token' },
    });

    const result = await authenticate(request);

    expect(mocks.requireSessionOrAppTokenMock).toHaveBeenCalledWith(request, { aud: 'coffee.imajin.ai' });
    expect(result).toEqual({ auth: { did: 'did:imajin:alice', scopes: ['profile:read'], via: 'token' } });
    expect(mocks.getSessionMock).not.toHaveBeenCalled();
  });

  it('accepts the shared kernel session cookie through the same adapter', async () => {
    mocks.requireSessionOrAppTokenMock.mockResolvedValue({
      auth: { did: 'did:imajin:alice', scopes: [], via: 'cookie' },
    });

    const result = await authenticate(request);

    expect(result).toEqual({ auth: { did: 'did:imajin:alice', scopes: [], via: 'cookie' } });
  });

  it("falls back to this app's own Sign-in-with-Imajin session on a 401", async () => {
    mocks.requireSessionOrAppTokenMock.mockResolvedValue({ error: 'Invalid or expired session', status: 401 });
    mocks.getSessionMock.mockResolvedValue({ did: 'did:imajin:bob' });

    const result = await authenticate(request);

    expect(result).toEqual({ auth: { did: 'did:imajin:bob', scopes: [], via: 'session' } });
  });

  it('returns the original 401 when no session exists either', async () => {
    mocks.requireSessionOrAppTokenMock.mockResolvedValue({ error: 'Invalid or expired session', status: 401 });

    const result = await authenticate(request);

    expect(result).toEqual({ error: 'Invalid or expired session', status: 401 });
  });

  it('treats a session lookup outside a request scope as unauthenticated', async () => {
    mocks.requireSessionOrAppTokenMock.mockResolvedValue({ error: 'Invalid or expired session', status: 401 });
    mocks.getSessionMock.mockRejectedValue(new Error('cookies() called outside a request scope'));

    const result = await authenticate(request);

    expect(result).toEqual({ error: 'Invalid or expired session', status: 401 });
  });

  it('does not fall back on a non-401 failure such as a missing scope', async () => {
    mocks.requireSessionOrAppTokenMock.mockResolvedValue({ error: 'Missing required scope(s): x', status: 403 });
    mocks.getSessionMock.mockResolvedValue({ did: 'did:imajin:bob' });

    const result = await authenticate(request);

    expect(result).toEqual({ error: 'Missing required scope(s): x', status: 403 });
    expect(mocks.getSessionMock).not.toHaveBeenCalled();
  });
});

describe('optionalCallerDid', () => {
  it('returns the caller DID when authenticated', async () => {
    mocks.requireSessionOrAppTokenMock.mockResolvedValue({ auth: { did: 'did:imajin:alice', scopes: [], via: 'token' } });

    expect(await optionalCallerDid(request)).toBe('did:imajin:alice');
  });

  it('returns null for anonymous callers', async () => {
    mocks.requireSessionOrAppTokenMock.mockResolvedValue({ error: 'nope', status: 401 });

    expect(await optionalCallerDid(request)).toBeNull();
  });
});
