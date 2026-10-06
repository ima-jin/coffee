import { requireSessionOrAppToken } from '@ima-jin/auth';
import { getSession } from '@ima-jin/auth-client';
import { authConfig } from '@/lib/auth-config';
import { thisAppHost } from '@/lib/env';

/**
 * This app's entire inbound-auth surface, funneled through one function so
 * no route imports an auth primitive directly (the same shape ima-jin/dykil
 * uses for its #1974 adoption).
 *
 * Order of evidence:
 *   1. `Authorization: Bearer <scoped app token>` — minted by the kernel at
 *      `POST {kernel}/auth/api/tokens/app` for `aud = thisAppHost()` and
 *      verified through `requireSessionOrAppToken` (@ima-jin/auth). This is
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
  /** Which path authenticated this request — for logging/debugging only. */
  via: 'token' | 'cookie' | 'session';
}

export type AuthenticateResult = { auth: AuthenticatedCaller } | { error: string; status: number };

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
  const result = await requireSessionOrAppToken(request, { aud: thisAppHost() });
  if ('auth' in result) {
    return { auth: result.auth };
  }
  if (result.status !== 401) {
    return { error: result.error, status: result.status };
  }

  const did = await readOwnSession();
  if (did) {
    return { auth: { did, scopes: [], via: 'session' } };
  }
  return { error: result.error, status: result.status };
}

/** Best-effort caller DID for routes that also serve anonymous callers. */
export async function optionalCallerDid(request: Request): Promise<string | null> {
  const result = await authenticate(request);
  return 'auth' in result ? result.auth.did : null;
}
