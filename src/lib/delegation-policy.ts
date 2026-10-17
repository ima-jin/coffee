import { evaluateDelegationPolicy, type DelegationDecision, type DelegationSource, type MutationClass } from '@ima-jin/auth/delegation-policy';

interface RoutePolicy {
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  action: string;
  class: MutationClass;
  why: string;
}

/** App-owned inventory, not the SDK's historical kernel route registry (#26 / #2360). */
export const DELEGATION_ROUTES = {
  'coffee.page.create': { method: 'POST', path: '/api/pages', action: 'create', class: 'value-moving', why: 'Establishes payment destinations and .fair seller attribution on a public page.' },
  'coffee.page.update': { method: 'PUT', path: '/api/pages/[handle]', action: 'update', class: 'reversible', why: 'Editable page details; payment destinations and visibility are escalated below.' },
  'coffee.page.delete': { method: 'DELETE', path: '/api/pages/[handle]', action: 'delete', class: 'irreversible', why: 'Deletes a page with no restore route.' },
  'coffee.tip.create': { method: 'POST', path: '/api/tip', action: 'tip', class: 'reversible', why: 'Pending tip/hosted checkout proposal; the payer separately authorizes Stripe or sends Solana.' },
  'coffee.checkout.create': { method: 'POST', path: '/api/checkout', action: 'checkout', class: 'reversible', why: 'Hosted checkout proposal; the payer still authorizes payment in Stripe.' },
} as const satisfies Record<string, RoutePolicy>;

/** Separate protocols, not delegated owner authority. Keep exceptions narrow and explicit. */
export const DELEGATION_EXCEPTIONS = [
  { method: 'POST', path: '/api/claim', why: 'One-time app bootstrap claim code, not owner session authority.' },
  { method: 'POST', path: '/api/auth/logout', why: 'SDK session logout, not an owner resource mutation.' },
  { method: 'POST', path: '/api/webhook/payment', why: 'Kernel-signed callback with audience and replay verification, not session authority.' },
] as const;

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function matchPath(template: string, path: string): Record<string, string> | null {
  const expected = template.split('/');
  const actual = path.split('/');
  if (expected.length !== actual.length) return null;
  const params: Record<string, string> = {};
  for (const [index, segment] of expected.entries()) {
    if (segment.startsWith('[')) {
      if (!actual[index]) return null;
      params[segment.slice(1, -1)] = actual[index];
    } else if (segment !== actual[index]) {
      return null;
    }
  }
  return params;
}

function requestPath(request: Request): string {
  const path = new URL(request.url).pathname;
  const base = process.env.NEXT_PUBLIC_BASE_PATH ?? '';
  return base && path.startsWith(`${base}/`) ? path.slice(base.length) : path;
}

/** PUT also accepts money-routing and disclosure fields, not just display metadata. */
async function updateMutation(request: Request): Promise<{ action: string; class: MutationClass } | null> {
  let body: unknown;
  try {
    body = await request.clone().json();
  } catch {
    return null; // The handler retains its existing malformed-body behavior.
  }
  if (!body || typeof body !== 'object') return null;
  if ('paymentMethods' in body) return { action: 'payment-methods-update', class: 'value-moving' };
  if ('isPublic' in body) return { action: 'visibility-update', class: 'irreversible' };
  return null;
}

/** Evaluated at the common auth boundary; proposal fields come entirely from the published SDK. */
export async function evaluateCoffeeDelegationPolicy(request: Request, source: DelegationSource): Promise<DelegationDecision> {
  if (SAFE_METHODS.has(request.method)) return { allowed: true };
  const path = requestPath(request);
  for (const [key, entry] of Object.entries(DELEGATION_ROUTES)) {
    if (entry.method !== request.method) continue;
    const params = matchPath(entry.path, path);
    if (!params) continue;
    const sensitive = key === 'coffee.page.update' ? await updateMutation(request) : null;
    return evaluateDelegationPolicy(source, {
      action: sensitive?.action ?? entry.action,
      class: sensitive?.class ?? entry.class,
      resourceId: params.handle,
    });
  }
  // Exceptions do not bypass this boundary: their handlers use a separate protocol.
  return evaluateDelegationPolicy(source, { action: 'unclassified-mutation', class: 'irreversible' });
}
