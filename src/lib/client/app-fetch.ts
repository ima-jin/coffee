import { withBasePath } from '@/lib/base-path';
import { APP_SLUG } from '@/lib/env';

/**
 * Browser-side fetch for this app's own authenticated API routes.
 *
 * Mints a short-lived scoped app token for this app's registry slug (#2706) from the signed-in
 * user's kernel session (`POST {kernel}/auth/api/tokens/app` — the same call
 * as `@ima-jin/auth-client`'s `requestAppToken`), caches it until shortly
 * before it expires, and presents it as `Authorization: Bearer <token>` — the
 * contract the routes verify with `requireSessionOrAppToken` (#1974).
 *
 * The mint call is inlined rather than imported: `@ima-jin/auth-client` has a
 * single entrypoint that also exports node-only code (`loadAppSigningKey`
 * imports `fs`/`crypto`/`path`), which cannot be bundled for the browser
 * (gap(kernel): no browser-safe subpath export).
 *
 * When no token can be minted (no kernel session reachable from this origin),
 * the request still goes out with `credentials: 'include'`, so the server's
 * session-cookie fallbacks apply.
 */

/** Refresh a cached token this long before it actually expires. */
const EXPIRY_SKEW_MS = 30_000;

let cached: { token: string; expiresAt: number } | null = null;

export function resetAppTokenCache(): void {
  cached = null;
}

async function getAppToken(): Promise<string | null> {
  if (cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }

  const authUrl = process.env.NEXT_PUBLIC_IMAJIN_AUTH_URL;
  if (!authUrl) return null;

  const minted = await mintAppToken(authUrl);
  if (!minted) return null;

  cached = { token: minted.token, expiresAt: Date.now() + minted.expiresIn * 1000 - EXPIRY_SKEW_MS };
  return minted.token;
}

interface MintedToken {
  token: string;
  expiresIn: number;
}

/** `POST {kernel}/auth/api/tokens/app`; null on any failure (unauthenticated, unregistered aud, unreachable). */
async function mintAppToken(authUrl: string): Promise<MintedToken | null> {
  try {
    const res = await fetch(`${authUrl}/auth/api/tokens/app`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aud: process.env.NEXT_PUBLIC_IMAJIN_APP_AUD || APP_SLUG, scopes: [] }),
    });
    if (!res.ok) return null;
    return (await res.json()) as MintedToken;
  } catch {
    return null;
  }
}

export async function appFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await getAppToken();
  const headers = new Headers(init.headers);
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  return fetch(withBasePath(path), { ...init, headers, credentials: 'include' });
}
