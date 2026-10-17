import { afterEach, describe, expect, it, vi } from 'vitest';
import { evaluateDelegationPolicy } from '@ima-jin/auth/delegation-policy';
import { DELEGATION_EXCEPTIONS, DELEGATION_ROUTES, evaluateCoffeeDelegationPolicy } from '@/lib/delegation-policy';

const DELEGATE = { id: 'did:imajin:agent', actingFor: 'did:imajin:owner' };
const OWNER = { id: 'did:imajin:owner' };

function request(method: string, path: string, body?: unknown) {
  return new Request(`https://coffee.test${path}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

afterEach(() => vi.unstubAllEnvs());

describe('coffee delegation inventory', () => {
  it.each(Object.values(DELEGATION_ROUTES))('$method $path matches the complete published SDK decision', async (entry) => {
    const path = entry.path.replaceAll('[handle]', 'creator');
    const mutation = { action: entry.action, class: entry.class, resourceId: entry.path.includes('[handle]') ? 'creator' : undefined };
    expect(await evaluateCoffeeDelegationPolicy(request(entry.method, path, {}), DELEGATE))
      .toEqual(evaluateDelegationPolicy(DELEGATE, mutation));
  });

  it.each(Object.values(DELEGATION_ROUTES))('$method $path leaves owner and self-delegation decisions unchanged', async (entry) => {
    const path = entry.path.replaceAll('[handle]', 'creator');
    for (const source of [OWNER, { ...OWNER, actingFor: OWNER.id }, null]) {
      expect(await evaluateCoffeeDelegationPolicy(request(entry.method, path, {}), source)).toEqual({ allowed: true });
    }
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('fails closed on unclassified delegated %s mutations', async (method) => {
    expect(await evaluateCoffeeDelegationPolicy(request(method, '/api/future/mutation'), DELEGATE))
      .toEqual(evaluateDelegationPolicy(DELEGATE, { action: 'unclassified-mutation', class: 'irreversible' }));
    expect(await evaluateCoffeeDelegationPolicy(request(method, '/api/future/mutation'), OWNER)).toEqual({ allowed: true });
  });

  it.each(DELEGATION_EXCEPTIONS)('does not turn $path into an auth-boundary bypass', async (entry) => {
    expect(await evaluateCoffeeDelegationPolicy(request(entry.method, entry.path), DELEGATE))
      .toEqual(evaluateDelegationPolicy(DELEGATE, { action: 'unclassified-mutation', class: 'irreversible' }));
  });

  it.each(['GET', 'HEAD', 'OPTIONS'])('does not gate safe %s requests', async (method) => {
    expect(await evaluateCoffeeDelegationPolicy(request(method, '/api/future'), DELEGATE)).toEqual({ allowed: true });
  });

  it.each(['/api/pages/', '/api/pages/creator/extra', '/api/pages/creator/', '/api/other/creator'])('fails closed on unmatched paths: %s', async (path) => {
    const result = await evaluateCoffeeDelegationPolicy(request('DELETE', path), DELEGATE);
    expect(result).toMatchObject({ allowed: false, body: { action: 'unclassified-mutation' } });
  });

  it('handles the configured proxy base path without matching unrelated prefixes', async () => {
    vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '/coffee');
    const expected = evaluateDelegationPolicy(DELEGATE, { action: 'delete', class: 'irreversible', resourceId: 'creator' });
    expect(await evaluateCoffeeDelegationPolicy(request('DELETE', '/coffee/api/pages/creator?ignored=true'), DELEGATE)).toEqual(expected);
    expect(await evaluateCoffeeDelegationPolicy(request('DELETE', '/coffee-other/api/pages/creator'), DELEGATE))
      .toMatchObject({ allowed: false, body: { action: 'unclassified-mutation' } });
  });
});

describe('page update escalation', () => {
  it.each([
    { paymentMethods: { solana: { address: 'different-address' } } },
    { paymentMethods: null },
    { paymentMethods: {}, title: 'Mixed', isPublic: true },
  ])('requires countersign for destination edits (%j)', async (body) => {
    expect(await evaluateCoffeeDelegationPolicy(request('PUT', '/api/pages/creator', body), DELEGATE))
      .toEqual(evaluateDelegationPolicy(DELEGATE, { action: 'payment-methods-update', class: 'value-moving', resourceId: 'creator' }));
  });

  it.each([true, false, null])('requires countersign for visibility writes (%j)', async (isPublic) => {
    expect(await evaluateCoffeeDelegationPolicy(request('PUT', '/api/pages/creator', { isPublic }), DELEGATE))
      .toEqual(evaluateDelegationPolicy(DELEGATE, { action: 'visibility-update', class: 'irreversible', resourceId: 'creator' }));
  });

  it('reads a clone without consuming the handler body', async () => {
    const req = request('PUT', '/api/pages/creator', { title: 'Draft details' });
    expect(await evaluateCoffeeDelegationPolicy(req, DELEGATE)).toEqual({ allowed: true });
    expect(await req.json()).toEqual({ title: 'Draft details' });
  });

  it.each([null, false, 42, 'text', [], {}])('leaves nonsensitive body validation to the handler (%j)', async (body) => {
    expect(await evaluateCoffeeDelegationPolicy(request('PUT', '/api/pages/creator', body), DELEGATE)).toEqual({ allowed: true });
  });

  it('leaves malformed JSON validation to the handler', async () => {
    const req = new Request('https://coffee.test/api/pages/creator', { method: 'PUT', body: '{' });
    expect(await evaluateCoffeeDelegationPolicy(req, DELEGATE)).toEqual({ allowed: true });
    expect(await req.text()).toBe('{');
  });
});
