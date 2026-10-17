import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireSessionOrAppTokenMock: vi.fn(),
  getSessionMock: vi.fn(),
}));

vi.mock('@ima-jin/auth', () => ({ requireSessionOrAppToken: mocks.requireSessionOrAppTokenMock }));
vi.mock('@ima-jin/auth-client', () => ({ getSession: mocks.getSessionMock }));
vi.mock('@/lib/auth-config', () => ({ authConfig: { secret: 'test-secret' } }));

import { authenticate, optionalAuthenticate, optionalCallerDid, authErrorResponse } from '../authenticate';
import { evaluateDelegationPolicy } from '@ima-jin/auth/delegation-policy';

const request = new Request('https://coffee.imajin.ai/api/pages/mine');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSessionMock.mockResolvedValue(null);
});

describe('delegation at the shared auth boundary', () => {
  it.each(['token', 'cookie'])('preserves the complete SDK proposal on the %s path without session fallback', async (via) => {
    const auth = { did: 'did:imajin:agent', actingFor: 'did:imajin:owner', via, scopes: [] };
    mocks.requireSessionOrAppTokenMock.mockResolvedValue({ auth });
    mocks.getSessionMock.mockResolvedValue({ did: 'did:imajin:owner' });
    const req = new Request('https://coffee.test/api/pages/creator', { method: 'DELETE' });
    const decision = evaluateDelegationPolicy({ id: auth.did, actingFor: auth.actingFor }, {
      action: 'delete', class: 'irreversible', resourceId: 'creator',
    });
    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error('Expected SDK proposal');
    const result = await authenticate(req);
    expect(result).toEqual({ error: decision.body.error, status: 403, proposal: decision.body });
    if ('auth' in result) throw new Error('Expected policy denial');
    expect(await authErrorResponse(result).json()).toEqual(decision.body);
    expect(mocks.getSessionMock).not.toHaveBeenCalled();
    expect(await optionalAuthenticate(req)).toEqual(result);
  });

  it('allows the owner to reissue from their own local session', async () => {
    mocks.requireSessionOrAppTokenMock.mockResolvedValue({ error: 'No shared cookie', status: 401 });
    mocks.getSessionMock.mockResolvedValue({ did: 'did:imajin:owner' });
    const req = new Request('https://coffee.test/api/pages/creator', { method: 'DELETE' });
    expect(await authenticate(req)).toEqual({ auth: { did: 'did:imajin:owner', scopes: [], via: 'session' } });
  });

  it('does not resolve actingFor into ownership for reversible requests', async () => {
    const auth = { did: 'did:imajin:agent', actingFor: 'did:imajin:owner', via: 'token', scopes: [] };
    mocks.requireSessionOrAppTokenMock.mockResolvedValue({ auth });
    const req = new Request('https://coffee.test/api/pages/creator', { method: 'PUT', body: '{"title":"New"}' });
    expect(await authenticate(req)).toEqual({ auth });
  });

  it('does not trust an unverified header as delegation on the local-session fallback', async () => {
    mocks.requireSessionOrAppTokenMock.mockResolvedValue({ error: 'No shared cookie', status: 401 });
    mocks.getSessionMock.mockResolvedValue({ did: 'did:imajin:agent' });
    const req = new Request('https://coffee.test/api/pages/mine', { headers: { 'X-Acting-For': 'did:imajin:owner' } });
    expect(await authenticate(req)).toEqual({ auth: { did: 'did:imajin:agent', scopes: [], via: 'session' } });
  });

  it('allows anonymous public requests only for a 401, not forbidden or unavailable auth', async () => {
    for (const status of [403, 503]) {
      const failure = { error: 'Auth refused', status };
      mocks.requireSessionOrAppTokenMock.mockResolvedValue(failure);
      expect(await optionalAuthenticate(request)).toEqual(failure);
    }
    mocks.requireSessionOrAppTokenMock.mockResolvedValue({ error: 'No session', status: 401 });
    expect(await optionalAuthenticate(request)).toEqual({ auth: null });
  });

  it('preserves plain auth errors as well as policy proposals', async () => {
    const response = authErrorResponse({ error: 'Not authenticated', status: 401 });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Not authenticated' });
  });
});

describe('authenticate', () => {
  it("verifies scoped app tokens against this app's registry slug, never its host (#2706)", async () => {
    mocks.requireSessionOrAppTokenMock.mockResolvedValue({
      auth: { did: 'did:imajin:alice', scopes: ['profile:read'], via: 'token' },
    });

    const result = await authenticate(request);

    expect(mocks.requireSessionOrAppTokenMock).toHaveBeenCalledWith(request, { slug: 'coffee' });
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
