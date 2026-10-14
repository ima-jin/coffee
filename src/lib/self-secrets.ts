import { loadFromVault, resolveKeystorePath, type AppVaultKeySpec } from '@ima-jin/auth-client';
import manifest from '../../imajin.app.json';
import { kernelUrl } from './env';

// Instrumentation and routes are separate Next bundles: share memory, not env or disk.
const SELF_SECRETS_KEY = Symbol.for('imajin.coffee.selfSecrets');

interface SelfSecretsStore {
  [SELF_SECRETS_KEY]?: Record<string, string>;
}

const requiredKeys: AppVaultKeySpec[] = manifest.secrets.map(({ name }) => ({
  key: name,
  onMissing: 'fail',
}));

export class SelfSecretsUnavailableError extends Error {
  constructor() {
    super(
      `${requiredKeys.map(({ key }) => key).join(', ')} unavailable from vault — ` +
      'on /jin select Sync manifest secrets for coffee and sign the proposal, then restart; no env fallback.'
    );
    this.name = 'SelfSecretsUnavailableError';
  }
}

/**
 * Called only after signing bootstrap/claim establishes this app's keystore.
 * No provider error/cause is retained: the boot framework reports this single
 * value-free diagnostic, without a duplicate app log or an untrusted response.
 */
export async function loadSelfSecrets(appDid: string): Promise<void> {
  const store = globalThis as SelfSecretsStore;
  delete store[SELF_SECRETS_KEY];
  try {
    const credentials = await loadFromVault({
      appDid,
      kernelUrl: kernelUrl(),
      keystorePath: resolveKeystorePath(process.env.IMAJIN_APP_KEYSTORE),
      keys: requiredKeys,
    });
    const values: Record<string, string> = Object.create(null);
    for (const { key } of requiredKeys) {
      const value = credentials.values[key];
      if (typeof value !== 'string' || value.length === 0 || credentials.degraded.includes(key)) {
        throw new SelfSecretsUnavailableError();
      }
      values[key] = value;
    }
    store[SELF_SECRETS_KEY] = values;
  } catch {
    throw new SelfSecretsUnavailableError();
  }
}

/** Fail closed even if a handler is imported before boot, or a stale env value exists. */
export function sessionSecret(): string {
  const value = (globalThis as SelfSecretsStore)[SELF_SECRETS_KEY]?.SESSION_SECRET;
  if (!value) throw new SelfSecretsUnavailableError();
  return value;
}

/** Clear readiness at boot; tests also use this to simulate a process restart. */
export function clearSelfSecrets(): void {
  delete (globalThis as SelfSecretsStore)[SELF_SECRETS_KEY];
}
