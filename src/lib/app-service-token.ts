import { randomBytes } from 'node:crypto';
import { signBootstrapPayload } from '@ima-jin/auth-client';
import { createLogger } from '@ima-jin/logger';
import { kernelUrl } from '@/lib/env';
import { getSigningIdentity } from '@/lib/signing-identity';

const log = createLogger('coffee');

/**
 * This app's own app-service token (`typ: app-service+jwt`), minted with
 * `POST {kernel}/auth/api/apps/token/service` (proof of possession with the
 * app key held by `loadAppSigningKey()`, see `signing-identity.ts`).
 *
 * The token is what coffee presents to the pay service — on `POST /api/checkout`
 * (binding the payment to this app's DID) and on `POST /api/settle`. It carries
 * no user identity and is never sent to a browser.
 *
 * `@ima-jin/auth-client` (<= 0.8.16) ships no helper for this mint — its
 * `requestAppToken` is the session-scoped user flow. Until it does, this module
 * is the single place the call lives; the Ed25519 signature itself comes from
 * the SDK's `signBootstrapPayload`, no crypto is implemented here.
 */

/** The operator-approved service scope that lets this app checkout + settle. */
export const PAY_SETTLE_SCOPE = 'pay:settle';

/** Refresh a cached token this long before it actually expires (kernel TTL is ~10 min). */
const EXPIRY_SKEW_MS = 60_000;

const MIN_NONCE_BYTES = 16;

interface CachedToken {
  token: string;
  expiresAt: number;
}

interface MintResponse {
  token?: unknown;
  expiresIn?: unknown;
  scopes?: unknown;
}

/** The kernel refused (or failed) the service-token mint. Never carries the token or signature. */
export class AppServiceTokenError extends Error {
  constructor(
    public readonly status: number,
    detail: string
  ) {
    super(`Failed to mint app-service token: ${status} ${detail}`);
    this.name = 'AppServiceTokenError';
  }
}

let cached: CachedToken | null = null;
let inFlight: Promise<string> | null = null;

/** Test-only (also safe to call after a 401 from pay): drop the cached token. */
export function resetAppServiceTokenCache(): void {
  cached = null;
  inFlight = null;
}

async function mint(): Promise<CachedToken> {
  const { appDid, privateKey } = getSigningIdentity();
  const nonce = randomBytes(MIN_NONCE_BYTES).toString('hex');
  const timestamp = new Date().toISOString();
  const signature = signBootstrapPayload(`${appDid}:${nonce}:${timestamp}`, privateKey);

  const res = await fetch(`${kernelUrl()}/auth/api/apps/token/service`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appDid, nonce, timestamp, signature }),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string };
    throw new AppServiceTokenError(res.status, body.error ?? res.statusText);
  }

  const minted = (await res.json()) as MintResponse;
  if (typeof minted.token !== 'string' || typeof minted.expiresIn !== 'number') {
    throw new AppServiceTokenError(502, 'malformed mint response');
  }

  const scopes = Array.isArray(minted.scopes) ? minted.scopes : [];
  if (!scopes.includes(PAY_SETTLE_SCOPE)) {
    // The mint drops the scope until the operator approves it for this app DID.
    log.warn({ appDid }, `[app-token] minted token lacks '${PAY_SETTLE_SCOPE}' — operator approval pending; pay will refuse it`);
  }

  return { token: minted.token, expiresAt: Date.now() + minted.expiresIn * 1000 - EXPIRY_SKEW_MS };
}

/**
 * A valid app-service token, minted on demand and cached until shortly before
 * it expires. Concurrent callers share one mint. Throws `AppServiceTokenError`
 * when the kernel refuses, or the signing identity is not bootstrapped (the
 * app is unclaimed) — callers decide whether that is fatal.
 */
export async function getAppServiceToken(): Promise<string> {
  if (cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }
  inFlight ??= mint()
    .then((minted) => {
      cached = minted;
      return minted.token;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}
