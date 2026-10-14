import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  generateBootstrapKeypair, writeKeystore, loadFromVault,
  createSessionToken, verifySessionToken,
} from '@ima-jin/auth-client';
import { register } from '../../../instrumentation';
import { bootstrapSigningIdentity, isAppClaimed, resetSigningIdentityForTests } from '../signing-identity';
import { loadSelfSecrets, sessionSecret, SelfSecretsUnavailableError } from '../self-secrets';
import { authConfig } from '../auth-config';

vi.mock('@ima-jin/auth-client', async (importOriginal) => ({
  ...await importOriginal<typeof import('@ima-jin/auth-client')>(),
  loadFromVault: vi.fn(),
}));

const { cookieGet } = vi.hoisted(() => ({ cookieGet: vi.fn() }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: cookieGet }) }));

const APP_DID = 'did:imajin:coffee-test';
const KERNEL = 'https://kernel.test';
const FAKE_SESSION = 'FAKE_TEST_ONLY_SESSION_GENERATION_ONE';
const FAKE_ROTATED = 'FAKE_TEST_ONLY_SESSION_GENERATION_TWO';
const user = { did: 'did:imajin:user-test', handle: 'test', displayName: 'Test', attestationId: 'fake-attestation' };

describe('vault-backed boot and sessions', () => {
  let dir: string;
  let keystorePath: string;
  let originalKeystore: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    resetSigningIdentityForTests();
    vi.resetModules();
    dir = await mkdtemp(join(tmpdir(), 'coffee-vault-test-'));
    keystorePath = join(dir, 'keystore.json');
    // Runtime-generated bootstrap keys, never a real app keystore.
    writeKeystore(keystorePath, generateBootstrapKeypair());
    originalKeystore = await readFile(keystorePath, 'utf8');
    vi.stubEnv('IMAJIN_APP_KEYSTORE', keystorePath);
    vi.stubEnv('IMAJIN_APP_DID', APP_DID);
    vi.stubEnv('IMAJIN_KERNEL_URL', KERNEL);
    vi.stubEnv('IMAJIN_AUTH_URL', KERNEL);
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://coffee.test');
    vi.stubEnv('IMAJIN_APP_PRIVATE_KEY', '');
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('SESSION_SECRET', undefined);
    vi.mocked(loadFromVault).mockReset().mockResolvedValue({
      values: { SESSION_SECRET: FAKE_SESSION }, degraded: [],
    });
    cookieGet.mockReset();
    fetchMock = vi.fn(async () => new Response(JSON.stringify({
      appDid: APP_DID, privateKey: 'FAKE_TEST_SIGNING_KEY', publicKey: 'FAKE_TEST_PUBLIC_KEY',
    }), { headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(async () => {
    resetSigningIdentityForTests();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await rm(dir, { recursive: true, force: true });
  });

  it('boots without secret env and serves a signed-in session via the real SDK handlers', async () => {
    // Import handlers before boot: neither import nor handler construction reads a secret.
    const { GET: callback } = await import('../../../app/api/auth/callback/route');
    const { GET: session } = await import('../../../app/api/auth/session/route');
    expect(() => authConfig.secret).toThrow(SelfSecretsUnavailableError);
    await register();
    expect(loadFromVault).toHaveBeenCalledTimes(1);
    expect(loadFromVault).toHaveBeenCalledWith({
      appDid: APP_DID, kernelUrl: KERNEL, keystorePath,
      keys: [{ key: 'SESSION_SECRET', onMissing: 'fail' }],
    });
    fetchMock.mockResolvedValue(new Response(JSON.stringify(user), {
      headers: { 'Content-Type': 'application/json' },
    }));
    const response = await callback(new NextRequest(
      'https://coffee.test/api/auth/callback?attestation_id=fake-attestation&user_did=did:imajin:user-test'
    ));
    const cookie = response.cookies.get('imajin_session');
    expect(cookie?.value).toBeTruthy();
    cookieGet.mockReturnValue(cookie);
    expect(await (await session()).json()).toMatchObject(user);
    expect(process.env.SESSION_SECRET).toBeUndefined();
    expect(await readFile(keystorePath, 'utf8')).toBe(originalKeystore);
    expect(await readdir(dir)).toEqual(['keystore.json']);
  });

  it('ignores an env credential before and after successful vault loading', async () => {
    vi.stubEnv('SESSION_SECRET', 'FAKE_STALE_ENV_ONLY');
    expect(() => sessionSecret()).toThrow(SelfSecretsUnavailableError);
    await register();
    expect(authConfig.secret).toBe(FAKE_SESSION);
    const token = await createSessionToken(user, authConfig);
    expect(await verifySessionToken(token, { secret: 'FAKE_STALE_ENV_ONLY' })).toBeNull();
    expect(process.env.SESSION_SECRET).toBe('FAKE_STALE_ENV_ONLY');
  });

  it('keeps signing and readiness blocked until vault loading resolves', async () => {
    let resolveLoad!: (value: Awaited<ReturnType<typeof loadFromVault>>) => void;
    const started = new Promise<void>((resolve) => {
      vi.mocked(loadFromVault).mockImplementation(() => {
        resolve();
        return new Promise((loaded) => { resolveLoad = loaded; });
      });
    });
    const boot = register();
    await started;
    expect(isAppClaimed()).toBe(false);
    expect(() => authConfig.secret).toThrow(SelfSecretsUnavailableError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolveLoad({ values: { SESSION_SECRET: FAKE_SESSION }, degraded: [] });
    await boot;
    expect(isAppClaimed()).toBe(true);
    expect(authConfig.secret).toBe(FAKE_SESSION);
  });

  it.each(['unreachable', 'missing', 'empty', 'degraded'] as const)(
    'fails boot closed for %s, with a single sanitized diagnostic and no stale fallback',
    async (failure) => {
      await register();
      vi.stubEnv('SESSION_SECRET', 'FAKE_STALE_ENV_ONLY');
      if (failure === 'unreachable') {
        vi.mocked(loadFromVault).mockRejectedValue(new Error('FAKE_PROVIDER_SENSITIVE_TEXT\nFAKE_PRIVATE_KEY'));
      } else {
        const values: Record<string, string> = {};
        if (failure !== 'missing') values.SESSION_SECRET = failure === 'empty' ? '' : FAKE_SESSION;
        vi.mocked(loadFromVault).mockResolvedValue({ values, degraded: failure === 'degraded' ? ['SESSION_SECRET'] : [] });
      }
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      const error = await register().catch((reason: unknown) => reason);
      expect(error).toMatchObject({ name: 'SelfSecretsUnavailableError' });
      const safeError = error as Error;
      expect(safeError.message).toContain('SESSION_SECRET');
      expect(safeError.message).toContain('/jin');
      expect(safeError.message).toContain('Sync manifest secrets');
      expect(safeError.message).toContain('restart');
      expect(safeError.message).not.toContain('\n');
      expect(safeError.message).not.toContain('FAKE_');
      expect(safeError.cause).toBeUndefined();
      // Next reports the thrown boot error once; the loader never logs a duplicate.
      expect(log).not.toHaveBeenCalled();
      expect(isAppClaimed()).toBe(false);
      expect(() => sessionSecret()).toThrow(SelfSecretsUnavailableError);
    }
  );

  it('sanitizes invalid non-secret configuration as well as provider failures', async () => {
    vi.stubEnv('IMAJIN_KERNEL_URL', '');
    await expect(loadSelfSecrets(APP_DID)).rejects.toThrow(SelfSecretsUnavailableError);
    expect(loadFromVault).not.toHaveBeenCalled();
  });

  it('also names the required secret when an unreachable kernel fails the preceding signing-key fetch', async () => {
    fetchMock.mockRejectedValue(new Error('FAKE_PROVIDER_SENSITIVE_TEXT'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(register()).rejects.toMatchObject({
      name: 'SelfSecretsUnavailableError',
      message: new SelfSecretsUnavailableError().message,
    });
    expect(loadFromVault).not.toHaveBeenCalled();
    expect(isAppClaimed()).toBe(false);
    expect(log).not.toHaveBeenCalled();
  });

  it('shares memory across separately loaded instrumentation and route modules', async () => {
    await register();
    vi.resetModules();
    const routeCopy = await import('../auth-config');
    expect(routeCopy.authConfig.secret).toBe(FAKE_SESSION);
    expect(loadFromVault).toHaveBeenCalledTimes(1);
  });

  it('picks up a rotated vault generation on restart without a file/env edit and rejects old sessions', async () => {
    await register();
    const oldToken = await createSessionToken(user, authConfig);
    expect(await verifySessionToken(oldToken, authConfig)).toEqual(user);
    resetSigningIdentityForTests();
    vi.mocked(loadFromVault).mockResolvedValue({ values: { SESSION_SECRET: FAKE_ROTATED }, degraded: [] });
    await register();
    expect(loadFromVault).toHaveBeenCalledTimes(2);
    expect(authConfig.secret).toBe(FAKE_ROTATED);
    expect(await verifySessionToken(oldToken, authConfig)).toBeNull();
    const newToken = await createSessionToken(user, authConfig);
    expect(await verifySessionToken(newToken, authConfig)).toEqual(user);
    expect(await readFile(keystorePath, 'utf8')).toBe(originalKeystore);
    expect(process.env.SESSION_SECRET).toBeUndefined();
  });

  it('preserves restricted unclaimed boot without loading vault credentials', async () => {
    vi.stubEnv('IMAJIN_APP_KEYSTORE', join(dir, 'absent.json'));
    await bootstrapSigningIdentity();
    expect(isAppClaimed()).toBe(false);
    expect(loadFromVault).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(() => authConfig.secret).toThrow(SelfSecretsUnavailableError);
  });
});
