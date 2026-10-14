import type { ImajinAuthConfig } from '@ima-jin/auth-client';
import { sessionSecret } from './self-secrets';

/**
 * Shared "Sign in with Imajin" config for every route handler in this app.
 * See @ima-jin/auth-client's README and docs/REGISTRATION.md.
 */
export const authConfig: ImajinAuthConfig = {
  // Do not snapshot at import/build time: boot must resolve before any signer runs.
  get secret() { return sessionSecret(); },
  authUrl: process.env.IMAJIN_AUTH_URL!,
  appDid: process.env.IMAJIN_APP_DID,
  publicUrl: process.env.NEXT_PUBLIC_APP_URL,
  loginRedirect: '/',
};
