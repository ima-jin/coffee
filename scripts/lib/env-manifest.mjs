/**
 * Single source of truth for every environment variable this app (or a
 * dependency it loads, or one of its scripts) reads — refs
 * ima-jin/imajin-ai#2498. Consumed by:
 *   - scripts/check-env.mjs              (deploy preflight; never prints values)
 *   - scripts/deploy.sh                  (scrubs inherited shell values)
 *   - scripts/__tests__/env-docs.test.ts (fails CI if .env.example or
 *     docs/ENVIRONMENTS.md omit a variable, or if code starts reading one
 *     that is not listed here)
 *
 * Examples here are shape-only placeholders — never real secrets.
 */
import { parseEnv } from 'node:util';
import { readFileSync } from 'node:fs';

export const TARGETS = {
  prod: { name: 'prod-coffee', port: 7100 },
  dev: { name: 'dev-coffee', port: 3100 },
};

export const BASE_PATH = '/coffee';
export const APP_SCHEMA = 'coffee';

/**
 * status:
 *   required         must be set in the env file for a deployed instance
 *   first-boot       required only on the very first boot, then removed
 *   optional         read, has a safe default when unset
 *   forbidden        must NOT be set (the app refuses to boot if it is)
 *   runtime-set      injected by Next.js / pm2 — not set in the env file
 *   dependency       read by an @ima-jin/* dependency on a code path coffee
 *                    does not exercise; leave unset
 *   template-unused  present in the app template's .env.example but not read
 *                    by any code in this repo; safe to omit
 * phase: 'build' = baked into the build (set before `next build`),
 *        'runtime' = read at process start / request time,
 *        'script' = read only by an operator/CI script or the test suite.
 */
export const ENV_VARS = [
  {
    name: 'DATABASE_URL',
    status: 'required',
    phase: 'runtime',
    secret: true,
    summary: "Postgres connection string for this app's own database (also read by drizzle-kit and scripts/migrate-baseline.mjs).",
    dev: 'postgres://<role>:<password>@localhost:5432/<dev_db>',
    prod: 'postgres://<role>:<password>@localhost:5432/<prod_db>',
  },
  {
    name: 'APP_DB_SCHEMA',
    status: 'required',
    phase: 'runtime',
    summary: 'The one Postgres schema this app owns. Fixed to `coffee` — the existing prod/dev schema; never change it.',
    dev: 'coffee',
    prod: 'coffee',
  },
  {
    name: 'IMAJIN_AUTH_URL',
    status: 'required',
    phase: 'runtime',
    summary: 'Kernel base URL (no path) used by @ima-jin/auth-client for session validation and the sign-in flow.',
    dev: 'https://dev-jin.imajin.ai',
    prod: 'https://jin.imajin.ai',
  },
  {
    name: 'NEXT_PUBLIC_IMAJIN_AUTH_URL',
    status: 'required',
    phase: 'build',
    summary: 'Same value as IMAJIN_AUTH_URL, exposed to the browser for the "Sign in with Imajin" redirect. Baked at build time; rebuild after changing.',
    dev: 'https://dev-jin.imajin.ai',
    prod: 'https://jin.imajin.ai',
  },
  {
    name: 'AUTH_SERVICE_URL',
    status: 'required',
    phase: 'runtime',
    summary: 'Kernel auth service base URL, including the /auth prefix. Read by @ima-jin/auth to verify scoped app tokens and sessions.',
    dev: 'https://dev-jin.imajin.ai/auth',
    prod: 'https://jin.imajin.ai/auth',
  },
  {
    name: 'REGISTRY_SERVICE_URL',
    status: 'required',
    phase: 'runtime',
    summary: "Kernel registry service base URL, including the /registry prefix. Public node config for .fair manifests.",
    dev: 'https://dev-jin.imajin.ai/registry',
    prod: 'https://jin.imajin.ai/registry',
  },
  {
    name: 'PAY_SERVICE_URL',
    status: 'required',
    phase: 'runtime',
    summary: "Kernel pay service base URL, including the /pay prefix. Target of Stripe Checkout creation and tip settlement.",
    dev: 'https://dev-jin.imajin.ai/pay',
    prod: 'https://jin.imajin.ai/pay',
  },
  {
    name: 'NEXT_PUBLIC_PAY_URL',
    status: 'required',
    phase: 'build',
    summary: 'Browser-visible base URL of the same pay service (Stripe Connect payout banner on /dashboard). Baked at build time; rebuild after changing.',
    dev: 'https://dev-jin.imajin.ai/pay',
    prod: 'https://jin.imajin.ai/pay',
  },
  {
    name: 'IMAJIN_KERNEL_URL',
    status: 'required',
    phase: 'runtime',
    summary: "Kernel base URL (no path). Used to fetch this app's signing key at boot (loadAppSigningKey) — same host as IMAJIN_AUTH_URL.",
    dev: 'https://dev-jin.imajin.ai',
    prod: 'https://jin.imajin.ai',
  },
  {
    name: 'NEXT_PUBLIC_KERNEL_URL',
    status: 'required',
    phase: 'runtime',
    summary:
      'Absolute kernel origin that @ima-jin/config\'s /dashboard -> hub redirect middleware targets (read dynamically as NEXT_PUBLIC_<SERVICE>_URL). Without it the redirect resolves to the wrong host (kernel.imajin.ai, or prod from dev). Set it before both `next build` and `next start`.',
    dev: 'https://dev-jin.imajin.ai',
    prod: 'https://jin.imajin.ai',
  },
  {
    name: 'NEXT_PUBLIC_BASE_PATH',
    status: 'required',
    phase: 'build',
    summary: 'Reverse-proxy path prefix the app is mounted under. Must be `/coffee`. Baked at build time; rebuild after changing.',
    dev: '/coffee',
    prod: '/coffee',
  },
  {
    name: 'NEXT_PUBLIC_APP_URL',
    status: 'required',
    phase: 'runtime',
    summary:
      "This app's public origin (no base path). Its HOST is the `aud` used to verify scoped app tokens — it must match a host in this app's registered tokenAudiences — and the origin of Stripe success/cancel redirects.",
    dev: 'https://dev-jin.imajin.ai',
    prod: 'https://jin.imajin.ai',
  },
  {
    name: 'IMAJIN_APP_DID',
    status: 'required',
    phase: 'runtime',
    summary: "This app's own did:imajin:… from registration (docs/REGISTRATION.md). instrumentation.ts refuses to boot without it. Not a secret.",
    dev: 'did:imajin:<dev app DID>',
    prod: 'did:imajin:<prod app DID>',
  },
  {
    name: 'NEXT_PUBLIC_IMAJIN_APP_ID',
    status: 'required',
    phase: 'build',
    summary: "This app's public registry id (`app_…`) from registration. Used client-side to build the sign-in redirect — safe to expose. Baked at build time.",
    dev: 'app_<dev registry id>',
    prod: 'app_<prod registry id>',
  },
  {
    name: 'SESSION_SECRET',
    status: 'required',
    phase: 'runtime',
    secret: true,
    summary: 'Secret used to sign this app\'s HS256 session cookie. Generate with `openssl rand -hex 32`; distinct for dev and prod; never committed.',
    dev: '(generate: openssl rand -hex 32)',
    prod: '(generate: openssl rand -hex 32)',
  },
  {
    name: 'WEBHOOK_SECRET',
    status: 'required',
    phase: 'runtime',
    secret: true,
    summary: 'Shared secret the kernel pay service presents on POST /api/webhook/payment (Authorization: Bearer …). Unset -> the webhook answers 500 and tips never complete.',
    dev: '(the dev pay service\'s webhook secret)',
    prod: '(the prod pay service\'s webhook secret)',
  },
  {
    name: 'PAY_SERVICE_API_KEY',
    status: 'optional',
    phase: 'runtime',
    secret: true,
    summary: 'Service key for POST {pay}/api/settle (service-to-service). Unset -> tip settlement is skipped (logged, non-fatal); set it wherever settlement should run. Env only, never committed.',
    dev: '(optional)',
    prod: '(set it on prod)',
  },
  {
    name: 'PLATFORM_DID',
    status: 'optional',
    phase: 'runtime',
    summary: 'Platform DID that receives the platform fee in .fair settlement (default did:imajin:platform).',
    dev: 'did:imajin:platform',
    prod: 'did:imajin:platform',
  },
  {
    name: 'PLATFORM_FEE_PERCENT',
    status: 'optional',
    phase: 'runtime',
    summary: 'Platform fee percentage applied to tips at settlement (default 1.5).',
    dev: '1.5',
    prod: '1.5',
  },
  {
    name: 'IMAJIN_ENV',
    status: 'optional',
    phase: 'runtime',
    summary:
      'Selects the kernel session cookie name in @ima-jin/config: `dev` → imajin_session_dev, anything else → imajin_session. MUST be `dev` on the dev instance (a production build is NODE_ENV=production, which does not imply dev); leave unset on prod.',
    dev: 'dev',
    prod: '(unset)',
  },
  {
    name: 'IMAJIN_APP_CLAIM_CODE',
    status: 'first-boot',
    phase: 'runtime',
    secret: true,
    summary:
      "One-time code from the kernel operator's /jin approval card. Needed only on the very first boot (no keystore yet) or a lost-keystore rebind; delete it after the first successful boot.",
    dev: '(only on first boot)',
    prod: '(only on first boot)',
  },
  {
    name: 'IMAJIN_APP_KEYSTORE',
    status: 'optional',
    phase: 'runtime',
    summary:
      "Path of this app's 0600 bootstrap keystore (never the vault key itself). Default ./.imajin/keystore.json relative to the process cwd. Must be writable, persist across deploys, and be separate for dev and prod.",
    dev: '/home/jin/.imajin/coffee.dev.keystore.json',
    prod: '/home/jin/.imajin/coffee.prod.keystore.json',
  },
  {
    name: 'IMAJIN_APP_PRIVATE_KEY',
    status: 'forbidden',
    phase: 'runtime',
    secret: true,
    summary: 'Removed. The app throws at boot if this is set — the signing key comes from loadAppSigningKey(), never from env.',
    dev: '(never set)',
    prod: '(never set)',
  },
  {
    name: 'PORT',
    status: 'runtime-set',
    phase: 'runtime',
    summary: 'Listen port. Set by the pm2 ecosystem entry (prod 7100, dev 3100); only used directly by `pnpm dev`.',
    dev: '3100',
    prod: '7100',
  },
  {
    name: 'NODE_ENV',
    status: 'runtime-set',
    phase: 'runtime',
    summary: 'Set to `production` by the pm2 entry and by `next build`/`next start`. Do not set it in the env file.',
    dev: 'production',
    prod: 'production',
  },
  {
    name: 'NEXT_RUNTIME',
    status: 'runtime-set',
    phase: 'runtime',
    summary: 'Injected by Next.js; instrumentation.ts only bootstraps the signing key when it is `nodejs`. Never set by hand.',
    dev: '(set by Next.js)',
    prod: '(set by Next.js)',
  },
  {
    name: 'NEXT_PUBLIC_VERSION',
    status: 'optional',
    phase: 'build',
    summary: 'Version string shown by /api/health and the UI build badge (default 0.0.0). Leave unset unless a release process stamps it.',
    dev: '(unset)',
    prod: '(unset)',
  },
  {
    name: 'NEXT_PUBLIC_BUILD_HASH',
    status: 'optional',
    phase: 'build',
    summary: 'Build identifier shown by /api/health and the UI build badge (default dev). Leave unset unless a release process stamps it.',
    dev: '(unset)',
    prod: '(unset)',
  },
  {
    name: 'NEXT_PUBLIC_COMMIT_COUNT',
    status: 'dependency',
    phase: 'build',
    summary: '@ima-jin/ui build badge. Cosmetic; leave unset.',
    dev: '(unset)',
    prod: '(unset)',
  },
  {
    name: 'NEXT_PUBLIC_NOTIFY_URL',
    status: 'dependency',
    phase: 'build',
    summary: '@ima-jin/ui notification widget endpoint. Not rendered by coffee; leave unset.',
    dev: '(unset)',
    prod: '(unset)',
  },
  {
    name: 'NEXT_PUBLIC_SERVICE_PREFIX',
    status: 'optional',
    phase: 'build',
    summary: 'Read by @ima-jin/config to derive service URLs when an explicit NEXT_PUBLIC_<SERVICE>_URL is unset. Prefer the explicit URLs; leave unset.',
    dev: '(unset)',
    prod: '(unset)',
  },
  {
    name: 'NEXT_PUBLIC_DOMAIN',
    status: 'optional',
    phase: 'build',
    summary: 'Companion to NEXT_PUBLIC_SERVICE_PREFIX (default imajin.ai). Leave unset; use the explicit URLs.',
    dev: '(unset)',
    prod: '(unset)',
  },
  {
    name: 'SESSION_COOKIE_SCOPE',
    status: 'optional',
    phase: 'runtime',
    summary: 'Read by @ima-jin/config to scope the session cookie (default: host). Leave unset.',
    dev: '(unset)',
    prod: '(unset)',
  },
  {
    name: 'REGISTRY_URL',
    status: 'dependency',
    phase: 'runtime',
    summary: '@ima-jin/config legacy alias for REGISTRY_SERVICE_URL. Leave unset; use REGISTRY_SERVICE_URL.',
    dev: '(unset)',
    prod: '(unset)',
  },
  {
    name: 'LOG_LEVEL',
    status: 'optional',
    phase: 'runtime',
    summary: 'pino log level for @ima-jin/logger (default info). Output is stdout only; pm2 captures it.',
    dev: 'debug',
    prod: 'info',
  },
  {
    name: 'ENABLE_REQUEST_LOG',
    status: 'optional',
    phase: 'runtime',
    summary: 'Logger request-log switch. Leave unset: this app wires no log sink (AGENTS.md — stdout only).',
    dev: '(unset)',
    prod: '(unset)',
  },
  {
    name: 'ENABLE_APP_LOG',
    status: 'optional',
    phase: 'runtime',
    summary: 'Logger persisted-log switch. Leave unset: this app never persists logs to a database.',
    dev: '(unset)',
    prod: '(unset)',
  },
  {
    name: 'LOG_DB_TRANSPORT',
    status: 'optional',
    phase: 'runtime',
    summary: 'Logger DB-transport switch. Leave unset: logging must never touch a data store (AGENTS.md).',
    dev: '(unset)',
    prod: '(unset)',
  },
  {
    name: 'APP_LOG_LEVEL',
    status: 'optional',
    phase: 'runtime',
    summary: 'Minimum level the logger would persist (default warn). Inert while persistence is off.',
    dev: '(unset)',
    prod: '(unset)',
  },
  {
    name: 'ATTESTATION_INTERNAL_API_KEY',
    status: 'dependency',
    phase: 'runtime',
    secret: true,
    summary: '@ima-jin/auth act-as / attestation calls. coffee exercises neither; leave unset. Never hand-mint it.',
    dev: '(unset)',
    prod: '(unset)',
  },
  {
    name: 'AUTH_INTERNAL_API_KEY',
    status: 'dependency',
    phase: 'runtime',
    secret: true,
    summary: 'Deprecated @ima-jin/auth internal key (agent delegation). Not used by coffee; leave unset.',
    dev: '(unset)',
    prod: '(unset)',
  },
  {
    name: 'PROFILE_SERVICE_URL',
    status: 'dependency',
    phase: 'runtime',
    summary: '@ima-jin/auth / @ima-jin/config credential and profile resolution. Not used by coffee; leave unset.',
    dev: '(unset)',
    prod: '(unset)',
  },
  {
    name: 'PROFILE_INTERNAL_API_KEY',
    status: 'dependency',
    phase: 'runtime',
    secret: true,
    summary: '@ima-jin/auth credential resolution key. Not used by coffee; leave unset.',
    dev: '(unset)',
    prod: '(unset)',
  },
  {
    name: 'NODE_DID',
    status: 'dependency',
    phase: 'runtime',
    summary: '@ima-jin/auth node-act-as check (kernel node DID). Not used by coffee; leave unset.',
    dev: '(unset)',
    prod: '(unset)',
  },
  {
    name: 'APP_URL',
    status: 'dependency',
    phase: 'runtime',
    summary: '@ima-jin/auth fallback origin for redirects. coffee does not rely on it; leave unset.',
    dev: '(unset)',
    prod: '(unset)',
  },
  {
    name: 'NEXT_PUBLIC_BASE_URL',
    status: 'dependency',
    phase: 'runtime',
    summary: '@ima-jin/auth fallback origin for redirects (after APP_URL). coffee does not rely on it; leave unset.',
    dev: '(unset)',
    prod: '(unset)',
  },
  {
    name: 'IMAJIN_APP_ATTESTATION_ID',
    status: 'template-unused',
    phase: 'runtime',
    summary: 'Listed in the app template; no code in this repo reads it. Safe to omit.',
    dev: '(unset)',
    prod: '(unset)',
  },
  {
    name: 'TEST_DATABASE_URL',
    status: 'optional',
    phase: 'script',
    secret: true,
    summary: 'Tests only: a Postgres URL the integration and migration-baseline tests may create throwaway databases on. Never set on a server.',
    dev: '(unset)',
    prod: '(unset)',
  },
];

export const ENV_VAR_NAMES = ENV_VARS.map((v) => v.name);

const PLACEHOLDER = /REPLACE_ME|CHANGE_ME/;

function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isLocalHost(hostname) {
  return hostname === 'localhost' || hostname === '::1' || hostname.startsWith('127.');
}

function checkKernelUrl(name, value, target, errors) {
  const url = parseUrl(value);
  if (url === null || !/^https?:$/.test(url.protocol)) {
    errors.push(`${name} is not a valid http(s) URL.`);
    return;
  }
  if (isLocalHost(url.hostname)) {
    errors.push(`${name} points at localhost — a deployed ${target} instance must use the real kernel host.`);
    return;
  }
  const isDevHost = url.hostname.startsWith('dev-');
  if (target === 'prod' && isDevHost) {
    errors.push(`${name} points at a dev host (${url.hostname}) in a prod env file.`);
  }
  if (target === 'dev' && !isDevHost) {
    errors.push(`${name} points at a non-dev host (${url.hostname}) in a dev env file — dev must never talk to the prod kernel.`);
  }
}

function checkPrefix(name, value, prefix, errors) {
  if (value !== '' && !value.replace(/\/+$/, '').endsWith(prefix)) {
    errors.push(`${name} must include the ${prefix} prefix.`);
  }
}

function checkBasics(get, errors) {
  const databaseUrl = get('DATABASE_URL');
  if (databaseUrl !== '' && !/^postgres(ql)?:$/.test(parseUrl(databaseUrl)?.protocol ?? '')) {
    errors.push('DATABASE_URL must be a postgres:// or postgresql:// URL.');
  }
  const schema = get('APP_DB_SCHEMA');
  if (schema !== '' && schema !== APP_SCHEMA) {
    errors.push(`APP_DB_SCHEMA must be \`${APP_SCHEMA}\` — the existing schema this app owns; renaming it orphans migration state.`);
  }
  const basePath = get('NEXT_PUBLIC_BASE_PATH');
  if (basePath !== '' && basePath !== BASE_PATH) {
    errors.push(`NEXT_PUBLIC_BASE_PATH must be ${BASE_PATH}.`);
  }
  const did = get('IMAJIN_APP_DID');
  if (did !== '' && !did.startsWith('did:imajin:')) {
    errors.push('IMAJIN_APP_DID must start with did:imajin:.');
  }
}

function checkUrls(get, target, errors) {
  for (const name of ['IMAJIN_AUTH_URL', 'NEXT_PUBLIC_IMAJIN_AUTH_URL', 'IMAJIN_KERNEL_URL', 'NEXT_PUBLIC_KERNEL_URL', 'NEXT_PUBLIC_APP_URL']) {
    if (get(name) !== '') checkKernelUrl(name, get(name), target, errors);
  }
  for (const [name, prefix] of [
    ['AUTH_SERVICE_URL', '/auth'],
    ['REGISTRY_SERVICE_URL', '/registry'],
    ['PAY_SERVICE_URL', '/pay'],
    ['NEXT_PUBLIC_PAY_URL', '/pay'],
  ]) {
    if (get(name) !== '') {
      checkKernelUrl(name, get(name), target, errors);
      checkPrefix(name, get(name), prefix, errors);
    }
  }
  const kernelHosts = new Set(
    ['IMAJIN_AUTH_URL', 'NEXT_PUBLIC_IMAJIN_AUTH_URL', 'IMAJIN_KERNEL_URL', 'NEXT_PUBLIC_KERNEL_URL']
      .filter((name) => get(name) !== '')
      .map((name) => parseUrl(get(name))?.host),
  );
  if (kernelHosts.size > 1) {
    errors.push('IMAJIN_AUTH_URL, NEXT_PUBLIC_IMAJIN_AUTH_URL, IMAJIN_KERNEL_URL and NEXT_PUBLIC_KERNEL_URL must point at the same kernel host.');
  }
}

/**
 * Pure validation of a parsed env file for a deploy target. Returns
 * `{ errors, warnings }`; messages name variables, never values.
 * @param {Record<string, string | undefined>} env
 * @param {'prod' | 'dev'} target
 */
export function validateEnv(env, target) {
  if (!(target in TARGETS)) {
    throw new Error(`Unknown target ${JSON.stringify(target)} — expected prod or dev.`);
  }
  const errors = [];
  const warnings = [];
  const get = (name) => (env[name] ?? '').trim();

  for (const variable of ENV_VARS) {
    const value = get(variable.name);
    if (variable.status === 'required' && value === '') {
      errors.push(`${variable.name} is required but not set.`);
    }
    if (variable.status === 'required' && PLACEHOLDER.test(value)) {
      errors.push(`${variable.name} is still a REPLACE_ME/CHANGE_ME placeholder — fill it in (docs/ENVIRONMENTS.md).`);
    }
    if (variable.status === 'forbidden' && value !== '') {
      errors.push(`${variable.name} must not be set (${variable.summary})`);
    }
  }

  checkBasics(get, errors);
  checkUrls(get, target, errors);

  const imajinEnv = get('IMAJIN_ENV');
  if (target === 'dev' && imajinEnv !== 'dev') {
    errors.push('IMAJIN_ENV must be `dev` on the dev instance (selects the imajin_session_dev cookie).');
  }
  if (target === 'prod' && imajinEnv === 'dev') {
    errors.push('IMAJIN_ENV=dev must not be set on prod (it would read the dev session cookie).');
  }

  const port = get('PORT');
  if (port !== '' && port !== String(TARGETS[target].port)) {
    warnings.push(`PORT is set in the env file but ${TARGETS[target].name} runs on ${TARGETS[target].port}; the pm2 entry's value wins.`);
  }
  if (get('IMAJIN_APP_CLAIM_CODE') !== '') {
    warnings.push('IMAJIN_APP_CLAIM_CODE is set — it is needed on the first boot only; remove it once the app has booted once.');
  }
  if (target === 'prod' && get('PAY_SERVICE_API_KEY') === '') {
    warnings.push('PAY_SERVICE_API_KEY is not set — tip settlement will be skipped on this instance.');
  }
  for (const name of ['ENABLE_APP_LOG', 'LOG_DB_TRANSPORT', 'ENABLE_REQUEST_LOG']) {
    if (get(name) === 'true') {
      warnings.push(`${name}=true — this app is stdout-logging only (AGENTS.md); leave it unset.`);
    }
  }

  return { errors, warnings };
}

/**
 * Reads and parses an env file WITHOUT touching process.env.
 * @param {string} path
 */
export function readEnvFile(path) {
  return parseEnv(readFileSync(path, 'utf8'));
}
