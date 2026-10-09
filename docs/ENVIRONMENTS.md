# Environments — coffee

Every environment variable the coffee app reads — directly, through its `@ima-jin/*` dependencies, or in its
scripts — with what it does, when it is read, and its dev and prod values. This file, `.env.example`, and
`scripts/lib/env-manifest.mjs` are kept in lock-step by `scripts/__tests__/env-docs.test.ts`: CI fails if code
starts reading a variable that is not documented here.

No secret values live in this repo. Examples are shape-only placeholders; real values live in the untracked
`.env.local` on each host.

## The three env files

| File | Used for | Lands at |
|---|---|---|
| `.env.example` | local development (`pnpm dev`) | `.env.local` in your working copy |
| `.env.dev.example` | the dev deployment (`dev-coffee`, port 3100, `https://dev-jin.imajin.ai/coffee`) | `~/dev/coffee/.env.local` |
| `.env.prod.example` | the prod deployment (`prod-coffee`, port 7100, `https://jin.imajin.ai/coffee`) | `~/prod/coffee/.env.local` |

On a server: `cp .env.<env>.example .env.local && chmod 600 .env.local`, fill the placeholders, then
`node scripts/check-env.mjs <prod|dev>`. `scripts/deploy.sh` runs that check for you on every deploy, and pm2 loads
the same file with `node --env-file` (see `ecosystem.config.cjs`). `check-env.mjs` prints variable names only,
never values, and rejects any required variable that is still a `REPLACE_ME` / `CHANGE_ME` placeholder.

## Build-time vs runtime

`next build` bakes every `NEXT_PUBLIC_*` value into the build (including `next.config.js`'s `basePath`).
**Changing one means rebuilding** — `scripts/deploy.sh` loads the env file for the build, so a normal deploy
handles it. Variables marked *runtime* are read when the process starts or per request; a
`pm2 restart --update-env` is enough.

## Dev vs prod at a glance

- **Kernel host.** Dev talks only to `https://dev-jin.imajin.ai`; prod only to `https://jin.imajin.ai`.
  `check-env.mjs` rejects a dev file pointing at a non-`dev-` host and a prod file pointing at a `dev-` host.
- **`IMAJIN_ENV`.** `dev` on dev (selects the `imajin_session_dev` cookie), **unset** on prod. A production build is
  `NODE_ENV=production` on both, so this is the only thing that tells dev from prod.
- **Database.** Separate Postgres database per environment; the schema name is `coffee` in both.
- **Keystore.** Separate `IMAJIN_APP_KEYSTORE` file per environment; each environment has its own app DID.
- **Port.** dev 3100, prod 7100 (from `ecosystem.config.cjs`, not the env file).
- **Secrets.** `SESSION_SECRET` is distinct per environment; `WEBHOOK_SECRET` must equal the matching pay service's.

## Required on every deployed instance

Missing any of these and `scripts/check-env.mjs` fails the deploy before anything is built.

| Variable | When | Dev | Prod | What it does |
|---|---|---|---|---|
| `DATABASE_URL` **(secret)** | runtime | `postgres://<role>:<password>@localhost:5432/<dev_db>` | `postgres://<role>:<password>@localhost:5432/<prod_db>` | Postgres connection string for this app's own database (also read by drizzle-kit and scripts/migrate-baseline.mjs). |
| `APP_DB_SCHEMA` | runtime | `coffee` | `coffee` | The one Postgres schema this app owns. Fixed to `coffee` — the existing prod/dev schema; never change it. |
| `IMAJIN_AUTH_URL` | runtime | `https://dev-jin.imajin.ai` | `https://jin.imajin.ai` | Kernel base URL (no path) used by @ima-jin/auth-client for session validation and the sign-in flow. |
| `NEXT_PUBLIC_IMAJIN_AUTH_URL` | build | `https://dev-jin.imajin.ai` | `https://jin.imajin.ai` | Same value as IMAJIN_AUTH_URL, exposed to the browser for the "Sign in with Imajin" redirect. Baked at build time; rebuild after changing. |
| `AUTH_SERVICE_URL` | runtime | `https://dev-jin.imajin.ai/auth` | `https://jin.imajin.ai/auth` | Kernel auth service base URL, including the /auth prefix. Read by @ima-jin/auth to verify scoped app tokens and sessions. |
| `REGISTRY_SERVICE_URL` | runtime | `https://dev-jin.imajin.ai/registry` | `https://jin.imajin.ai/registry` | Kernel registry service base URL, including the /registry prefix. Public node config for .fair manifests. |
| `PAY_SERVICE_URL` | runtime | `https://dev-jin.imajin.ai/pay` | `https://jin.imajin.ai/pay` | Kernel pay service base URL, including the /pay prefix. Target of Stripe Checkout creation and tip settlement. |
| `NEXT_PUBLIC_PAY_URL` | build | `https://dev-jin.imajin.ai/pay` | `https://jin.imajin.ai/pay` | Browser-visible base URL of the same pay service (Stripe Connect payout banner on /dashboard). Baked at build time; rebuild after changing. |
| `IMAJIN_KERNEL_URL` | runtime | `https://dev-jin.imajin.ai` | `https://jin.imajin.ai` | Kernel base URL (no path). Used to fetch this app's signing key at boot (loadAppSigningKey) and to mint its app-service token (POST /auth/api/apps/token/service) for pay checkout + settle — same host as IMAJIN_AUTH_URL. |
| `NEXT_PUBLIC_KERNEL_URL` | runtime | `https://dev-jin.imajin.ai` | `https://jin.imajin.ai` | Absolute kernel origin that @ima-jin/config's /dashboard -> hub redirect middleware targets (read dynamically as NEXT_PUBLIC_<SERVICE>_URL). Without it the redirect resolves to the wrong host (kernel.imajin.ai, or prod from dev). Set it before both `next build` and `next start`. |
| `NEXT_PUBLIC_BASE_PATH` | build | `/coffee` | `/coffee` | Reverse-proxy path prefix the app is mounted under. Must be `/coffee`. Baked at build time; rebuild after changing. |
| `NEXT_PUBLIC_APP_URL` | runtime | `https://dev-jin.imajin.ai` | `https://jin.imajin.ai` | This app's public origin (no base path). The origin of Stripe success/cancel redirects and OpenGraph URLs. It is NOT the token audience: scoped app tokens are verified against the registry slug (see IMAJIN_APP_AUD). |
| `IMAJIN_APP_DID` | runtime | `did:imajin:<dev app DID>` | `did:imajin:<prod app DID>` | This app's own did:imajin:… from registration (docs/REGISTRATION.md). instrumentation.ts refuses to boot without it. Not a secret. |
| `NEXT_PUBLIC_IMAJIN_APP_ID` | build | `app_<dev registry id>` | `app_<prod registry id>` | This app's public registry id (`app_…`) from registration. Used client-side to build the sign-in redirect — safe to expose. Baked at build time. |
| `SESSION_SECRET` **(secret)** | runtime | (generate: openssl rand -hex 32) | (generate: openssl rand -hex 32) | Secret used to sign this app's HS256 session cookie. Generate with `openssl rand -hex 32`; distinct for dev and prod; never committed. |
| `WEBHOOK_SECRET` **(secret)** | runtime | (the dev pay service's webhook secret) | (the prod pay service's webhook secret) | Shared secret the kernel pay service presents on POST /api/webhook/payment (Authorization: Bearer …). Unset -> the webhook answers 500 and tips never complete. |

## First boot only

Set once, then delete. This is how the operator's claim code is spent (see [Identity](../README.md#identity)).

| Variable | When | Dev | Prod | What it does |
|---|---|---|---|---|
| `IMAJIN_APP_CLAIM_CODE` **(secret)** | runtime | (only on first boot) | (only on first boot) | One-time code from the kernel operator's /jin approval card. Needed only on the very first boot (no keystore yet) or a lost-keystore rebind; delete it after the first successful boot. |

## Optional

| Variable | When | Dev | Prod | What it does |
|---|---|---|---|---|
| `PLATFORM_DID` | runtime | `did:imajin:platform` | `did:imajin:platform` | Platform DID that receives the platform fee in .fair settlement (default did:imajin:platform). |
| `PLATFORM_FEE_PERCENT` | runtime | `1.5` | `1.5` | Platform fee percentage applied to tips at settlement (default 1.5). |
| `IMAJIN_ENV` | runtime | `dev` | (unset) | Selects the kernel session cookie name in @ima-jin/config: `dev` → imajin_session_dev, anything else → imajin_session. MUST be `dev` on the dev instance (a production build is NODE_ENV=production, which does not imply dev); leave unset on prod. |
| `IMAJIN_APP_AUD` | runtime | (unset) | (unset) | Operator override of the audience scoped app tokens are verified against (read by @ima-jin/auth; default: this app's registry slug `coffee`). Must be a registry slug, never a host or URL — path-routed apps share one host (#2706). Unset on dev and prod unless the registry slug differs. |
| `NEXT_PUBLIC_IMAJIN_APP_AUD` | build | (unset) | (unset) | Browser-side twin of IMAJIN_APP_AUD: the audience the dashboard/edit pages request when minting a scoped app token (default `coffee`). Set it to the same value as IMAJIN_APP_AUD, and only when that is set. Baked at build time; rebuild after changing. |
| `IMAJIN_APP_KEYSTORE` | runtime | `/home/jin/.imajin/coffee.dev.keystore.json` | `/home/jin/.imajin/coffee.prod.keystore.json` | Path of this app's 0600 bootstrap keystore (never the vault key itself). Default ./.imajin/keystore.json relative to the process cwd. Must be writable, persist across deploys, and be separate for dev and prod. |
| `NEXT_PUBLIC_VERSION` | build | (unset) | (unset) | Version string shown by /api/health and the UI build badge (default 0.0.0). Leave unset unless a release process stamps it. |
| `NEXT_PUBLIC_BUILD_HASH` | build | (unset) | (unset) | Build identifier shown by /api/health and the UI build badge (default dev). Leave unset unless a release process stamps it. |
| `NEXT_PUBLIC_SERVICE_PREFIX` | build | (unset) | (unset) | Read by @ima-jin/config to derive service URLs when an explicit NEXT_PUBLIC_<SERVICE>_URL is unset. Prefer the explicit URLs; leave unset. |
| `NEXT_PUBLIC_DOMAIN` | build | (unset) | (unset) | Companion to NEXT_PUBLIC_SERVICE_PREFIX (default imajin.ai). Leave unset; use the explicit URLs. |
| `SESSION_COOKIE_SCOPE` | runtime | (unset) | (unset) | Read by @ima-jin/config to scope the session cookie (default: host). Leave unset. |
| `LOG_LEVEL` | runtime | `debug` | `info` | pino log level for @ima-jin/logger (default info). Output is stdout only; pm2 captures it. |
| `ENABLE_REQUEST_LOG` | runtime | (unset) | (unset) | Logger request-log switch. Leave unset: this app wires no log sink (AGENTS.md — stdout only). |
| `ENABLE_APP_LOG` | runtime | (unset) | (unset) | Logger persisted-log switch. Leave unset: this app never persists logs to a database. |
| `LOG_DB_TRANSPORT` | runtime | (unset) | (unset) | Logger DB-transport switch. Leave unset: logging must never touch a data store (AGENTS.md). |
| `APP_LOG_LEVEL` | runtime | (unset) | (unset) | Minimum level the logger would persist (default warn). Inert while persistence is off. |
| `TEST_DATABASE_URL` **(secret)** | script | (unset) | (unset) | Tests only: a Postgres URL the integration and migration-baseline tests may create throwaway databases on. Never set on a server. |

## Forbidden

The app refuses to boot if these are set.

| Variable | When | Dev | Prod | What it does |
|---|---|---|---|---|
| `IMAJIN_APP_PRIVATE_KEY` **(secret)** | runtime | (never set) | (never set) | Removed. The app throws at boot if this is set — the signing key comes from loadAppSigningKey(), never from env. |

## Set by the platform

Never put these in the env file.

| Variable | When | Dev | Prod | What it does |
|---|---|---|---|---|
| `PORT` | runtime | `3100` | `7100` | Listen port. Set by the pm2 ecosystem entry (prod 7100, dev 3100); only used directly by `pnpm dev`. |
| `NODE_ENV` | runtime | `production` | `production` | Set to `production` by the pm2 entry and by `next build`/`next start`. Do not set it in the env file. |
| `NEXT_RUNTIME` | runtime | (set by Next.js) | (set by Next.js) | Injected by Next.js; instrumentation.ts only bootstraps the signing key when it is `nodejs`. Never set by hand. |

## Read by dependencies, not used by coffee

Leave unset. Listed so that nothing the process can read is undocumented.

| Variable | When | Dev | Prod | What it does |
|---|---|---|---|---|
| `NEXT_PUBLIC_COMMIT_COUNT` | build | (unset) | (unset) | @ima-jin/ui build badge. Cosmetic; leave unset. |
| `NEXT_PUBLIC_NOTIFY_URL` | build | (unset) | (unset) | @ima-jin/ui notification widget endpoint. Not rendered by coffee; leave unset. |
| `REGISTRY_URL` | runtime | (unset) | (unset) | @ima-jin/config legacy alias for REGISTRY_SERVICE_URL. Leave unset; use REGISTRY_SERVICE_URL. |
| `ATTESTATION_INTERNAL_API_KEY` **(secret)** | runtime | (unset) | (unset) | @ima-jin/auth act-as / attestation calls. coffee exercises neither; leave unset. Never hand-mint it. |
| `AUTH_INTERNAL_API_KEY` **(secret)** | runtime | (unset) | (unset) | Deprecated @ima-jin/auth internal key (agent delegation). Not used by coffee; leave unset. |
| `PROFILE_SERVICE_URL` | runtime | (unset) | (unset) | @ima-jin/auth / @ima-jin/config credential and profile resolution. Not used by coffee; leave unset. |
| `PROFILE_INTERNAL_API_KEY` **(secret)** | runtime | (unset) | (unset) | @ima-jin/auth credential resolution key. Not used by coffee; leave unset. |
| `NODE_DID` | runtime | (unset) | (unset) | @ima-jin/auth node-act-as check (kernel node DID). Not used by coffee; leave unset. |
| `APP_URL` | runtime | (unset) | (unset) | @ima-jin/auth fallback origin for redirects. coffee does not rely on it; leave unset. |
| `NEXT_PUBLIC_BASE_URL` | runtime | (unset) | (unset) | @ima-jin/auth fallback origin for redirects (after APP_URL). coffee does not rely on it; leave unset. |

## In the app template, not read by coffee

Safe to omit.

| Variable | When | Dev | Prod | What it does |
|---|---|---|---|---|
| `IMAJIN_APP_ATTESTATION_ID` | runtime | (unset) | (unset) | Listed in the app template; no code in this repo reads it. Safe to omit. |

## Dev example

```dotenv
# coffee — DEV deployment env (dev-coffee, port 3100, https://dev-jin.imajin.ai/coffee)
# Copy to ~/dev/coffee/.env.local on the server (chmod 600) and fill the
# placeholders. Never commit the real file. Reference: docs/ENVIRONMENTS.md.
# Validate with: node scripts/check-env.mjs dev

# --- Build-time (baked in by `next build` — rebuild after changing) ---
NEXT_PUBLIC_BASE_PATH=/coffee
NEXT_PUBLIC_KERNEL_URL=https://dev-jin.imajin.ai
NEXT_PUBLIC_IMAJIN_AUTH_URL=https://dev-jin.imajin.ai
NEXT_PUBLIC_PAY_URL=https://dev-jin.imajin.ai/pay
NEXT_PUBLIC_IMAJIN_APP_ID=app_REPLACE_ME

# --- Runtime ---
# PORT and NODE_ENV come from the pm2 entry (ecosystem.config.cjs).
NEXT_PUBLIC_APP_URL=https://dev-jin.imajin.ai
# MUST be `dev` here: selects the imajin_session_dev cookie.
IMAJIN_ENV=dev

DATABASE_URL=postgres://coffee:CHANGE_ME@localhost:5432/imajin_dev
APP_DB_SCHEMA=coffee

IMAJIN_AUTH_URL=https://dev-jin.imajin.ai
IMAJIN_KERNEL_URL=https://dev-jin.imajin.ai
AUTH_SERVICE_URL=https://dev-jin.imajin.ai/auth
REGISTRY_SERVICE_URL=https://dev-jin.imajin.ai/registry
PAY_SERVICE_URL=https://dev-jin.imajin.ai/pay

# Shared secrets (never commit real values): openssl rand -hex 32 for SESSION_SECRET;
# WEBHOOK_SECRET must equal the dev pay service's webhook secret.
SESSION_SECRET=REPLACE_ME
WEBHOOK_SECRET=REPLACE_ME

# --- Identity (operator step: README "Identity", docs/REGISTRATION.md) ---
IMAJIN_APP_DID=did:imajin:REPLACE_ME
# First boot only — the one-time claim code from the /jin approval card.
# Delete it after the app has booted once.
# IMAJIN_APP_CLAIM_CODE=
# Persistent, per-environment keystore (must survive deploys):
IMAJIN_APP_KEYSTORE=/home/jin/.imajin/coffee.dev.keystore.json

LOG_LEVEL=debug
```

## Prod example

```dotenv
# coffee — PROD deployment env (prod-coffee, port 7100, https://jin.imajin.ai/coffee)
# Copy to ~/prod/coffee/.env.local on the server (chmod 600) and fill the
# placeholders. Never commit the real file. Reference: docs/ENVIRONMENTS.md.
# Validate with: node scripts/check-env.mjs prod

# --- Build-time (baked in by `next build` — rebuild after changing) ---
NEXT_PUBLIC_BASE_PATH=/coffee
NEXT_PUBLIC_KERNEL_URL=https://jin.imajin.ai
NEXT_PUBLIC_IMAJIN_AUTH_URL=https://jin.imajin.ai
NEXT_PUBLIC_PAY_URL=https://jin.imajin.ai/pay
NEXT_PUBLIC_IMAJIN_APP_ID=app_REPLACE_ME

# --- Runtime ---
# PORT and NODE_ENV come from the pm2 entry (ecosystem.config.cjs).
NEXT_PUBLIC_APP_URL=https://jin.imajin.ai
# IMAJIN_ENV is deliberately NOT set on prod (prod uses the imajin_session
# cookie). check-env.mjs rejects IMAJIN_ENV=dev here.

DATABASE_URL=postgres://coffee:CHANGE_ME@localhost:5432/imajin_prod
APP_DB_SCHEMA=coffee

IMAJIN_AUTH_URL=https://jin.imajin.ai
IMAJIN_KERNEL_URL=https://jin.imajin.ai
AUTH_SERVICE_URL=https://jin.imajin.ai/auth
REGISTRY_SERVICE_URL=https://jin.imajin.ai/registry
PAY_SERVICE_URL=https://jin.imajin.ai/pay

# Shared secrets (never commit real values): openssl rand -hex 32 for SESSION_SECRET;
# WEBHOOK_SECRET must equal the prod pay service's webhook secret.
SESSION_SECRET=REPLACE_ME
WEBHOOK_SECRET=REPLACE_ME

# --- Identity (operator step: README "Identity", docs/REGISTRATION.md) ---
IMAJIN_APP_DID=did:imajin:REPLACE_ME
# First boot only — the one-time claim code from the /jin approval card.
# Delete it after the app has booted once.
# IMAJIN_APP_CLAIM_CODE=
# Persistent, per-environment keystore (must survive deploys):
IMAJIN_APP_KEYSTORE=/home/jin/.imajin/coffee.prod.keystore.json

LOG_LEVEL=info
```
