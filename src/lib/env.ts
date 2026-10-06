/**
 * Central env-var accessors. `.env.example` is the contract — no URL to the
 * kernel (or to any other service) is hard-coded anywhere else in this app.
 */

const FALLBACK_APP_HOST = 'coffee.imajin.ai';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set — see .env.example.`);
  }
  return value;
}

function stripTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === '/') end -= 1;
  return url.slice(0, end);
}

/** Base URL of the kernel's pay service, e.g. https://dev-jin.imajin.ai/pay. */
export function payServiceUrl(): string {
  return stripTrailingSlashes(required('PAY_SERVICE_URL'));
}

/** Shared secret the pay service presents on `POST /api/webhook/payment`. */
export function webhookSecret(): string | undefined {
  return process.env.WEBHOOK_SECRET || undefined;
}

/**
 * This app's own host, used as the `aud` for scoped app-token verification
 * (see `@ima-jin/auth`'s `requireSessionOrAppToken`). A token minted for any
 * other host can never verify here.
 */
export function thisAppHost(): string {
  const base = process.env.NEXT_PUBLIC_APP_URL;
  if (!base) return FALLBACK_APP_HOST;
  try {
    return new URL(base).host;
  } catch {
    return FALLBACK_APP_HOST;
  }
}

/**
 * Absolute public URL of this app (origin + optional basePath), used for
 * Stripe success/cancel redirects and OpenGraph URLs.
 */
export function publicAppUrl(): string {
  const origin = stripTrailingSlashes(required('NEXT_PUBLIC_APP_URL'));
  return `${origin}${process.env.NEXT_PUBLIC_BASE_PATH ?? ''}`;
}
