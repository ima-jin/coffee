/**
 * Central env-var accessors. `.env.example` is the contract — no URL to the
 * kernel (or to any other service) is hard-coded anywhere else in this app.
 */

/**
 * This app's registry slug — the default audience of its scoped app tokens
 * (#2706). Tokens are minted and verified against the slug, never a host: every
 * path-routed app on a node shares one host. `IMAJIN_APP_AUD` overrides it on
 * the server (read inside `@ima-jin/auth`); `NEXT_PUBLIC_IMAJIN_APP_AUD` is its
 * browser-side twin for the token mint in `src/lib/client/app-fetch.ts`.
 */
export const APP_SLUG = 'coffee';

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

/** Kernel base URL (no path), e.g. https://dev-jin.imajin.ai — the host of `/auth/api/apps/token/service`. */
export function kernelUrl(): string {
  return stripTrailingSlashes(required('IMAJIN_KERNEL_URL'));
}

/** Shared secret the pay service presents on `POST /api/webhook/payment`. */
export function webhookSecret(): string | undefined {
  return process.env.WEBHOOK_SECRET || undefined;
}

/**
 * Absolute public URL of this app (origin + optional basePath), used for
 * Stripe success/cancel redirects and OpenGraph URLs.
 */
export function publicAppUrl(): string {
  const origin = stripTrailingSlashes(required('NEXT_PUBLIC_APP_URL'));
  return `${origin}${process.env.NEXT_PUBLIC_BASE_PATH ?? ''}`;
}
