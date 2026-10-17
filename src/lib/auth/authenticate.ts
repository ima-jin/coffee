import { requireSessionOrAppToken } from '@ima-jin/auth';
import { getSession } from '@ima-jin/auth-client';
import { authConfig } from '@/lib/auth-config';
import { APP_SLUG } from '@/lib/env';
import { evaluateCoffeeDelegationPolicy } from '@/lib/delegation-policy';
import type { DelegationPolicyBody } from '@ima-jin/auth/delegation-policy';

/**
 * This app's entire inbound-auth surface, funneled through one function so
 * no route imports an auth primitive directly (the same shape ima-jin/dykil
 * uses for its #1974 adoption).
 *
 * Order of evidence:
 *   1. `Authorization: Bearer <scoped app token>` — minted by the kernel at
 *      `POST {kernel}/auth/api/tokens/app` for `aud = <registry slug>` and
 *      verified through `requireSessionOrAppToken` (@ima-jin/auth). The
 *      audience is this app's registry slug (`coffee`, or `IMAJIN_APP_AUD`),
 *      never the host it is served from: path-routed apps share one host, so a
 *      host audience would let apps accept each other's tokens (#2706). This is
 *      the preferred, end-to-end path (#1974 / #1069 Phase 1).
 *   2. The legacy shared kernel session cookie, which the same
 *      `requireSessionOrAppToken` call accepts as a migration fallback.
 *   3. This app's own "Sign in with Imajin" session cookie
 *      (`@ima-jin/auth-client`'s `getSession`) — what a split-domain
 *      deployment, with no shared kernel cookie, actually has.
 *
 * Scopes are not required: the kernel clamps requested scopes to its closed
 * SCOPES vocabulary, which has no coffee-specific entry.
 */
export interface AuthenticatedCaller {
  /** DID of the authenticated caller. */
  did: string;
  /** Capability scopes granted to this call (empty on cookie paths). */
  scopes: string[];
  /**
   * Owner DID when the caller is an agent acting under `X-Acting-For`; feeds the
   * delegation policy (#2360). The SDK verifies the grant on token/cookie paths.
   * Coffee still uses the caller DID, never this owner DID, for ownership.
   */
  actingFor?: string;
  /** Which path authenticated this request — for logging/debugging only. */
  via: 'token' | 'cookie' | 'session';
}

export interface AuthenticationError {
  error: string;
  status: number;
  /** Complete SDK proposal; never reduce this to just the human-readable error. */
  proposal?: DelegationPolicyBody;
}

export type AuthenticateResult = { auth: AuthenticatedCaller } | AuthenticationError;

export function authErrorResponse(result: AuthenticationError): Response {
  return Response.json(result.proposal ?? { error: result.error }, { status: result.status });
}

async function authorizeMutation(request: Request, auth: AuthenticatedCaller): Promise<AuthenticateResult> {
  const decision = await evaluateCoffeeDelegationPolicy(request, { id: auth.did, actingFor: auth.actingFor });
  if (!decision.allowed) {
    return { error: decision.body.error, status: decision.status, proposal: decision.body };
  }
  return { auth };
}

async function readOwnSession(): Promise<string | null> {
  try {
    const user = await getSession(authConfig);
    return user?.did ?? null;
  } catch {
    // `cookies()` is only callable inside a Next.js request scope.
    return null;
  }
}

export async function authenticate(request: Request): Promise<AuthenticateResult> {
  const result = await requireSessionOrAppToken(request, { slug: APP_SLUG });
  if ('auth' in result) {
    return authorizeMutation(request, result.auth);
  }
  if (result.status !== 401) {
    return { error: result.error, status: result.status };
  }

  const did = await readOwnSession();
  if (did) {
    return authorizeMutation(request, { did, scopes: [], via: 'session' });
  }
  return { error: result.error, status: result.status };
}

/** Best-effort caller DID for routes that also serve anonymous callers. */
export async function optionalAuthenticate(request: Request): Promise<{ auth: AuthenticatedCaller | null } | AuthenticationError> {
  const result = await authenticate(request);
  // Public mutations may be anonymous, but a refusal must never become anonymous success.
  if ('error' in result && result.status === 401) return { auth: null };
  return result;
}

/** Best-effort caller DID for read-only consumers. Do not use for mutations. */
export async function optionalCallerDid(request: Request): Promise<string | null> {
  const result = await authenticate(request);
  return 'auth' in result ? result.auth.did : null;
}
