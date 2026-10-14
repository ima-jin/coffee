# Deploying coffee (prod + dev)

coffee is deployed from **this repo**, as its own pm2 process behind the kernel host's Caddy. Nothing in
`ima-jin/imajin-ai` builds, migrates, or restarts it once the cutover below is done (imajin-ai#1984).

| | dev | prod |
|---|---|---|
| pm2 process | `dev-coffee` | `prod-coffee` |
| Checkout on the server | `~/dev/coffee` | `~/prod/coffee` |
| Local port | `3100` | `7100` |
| Public URL | `https://dev-jin.imajin.ai/coffee` | `https://jin.imajin.ai/coffee` |
| Health | `http://127.0.0.1:3100/coffee/api/health` | `http://127.0.0.1:7100/coffee/api/health` |

The pm2 names, ports, and Caddy route are the ones the kernel monorepo already used for coffee, so nothing
upstream of the app changes.

## Vault-backed session upgrade prerequisite

**Before upgrading this app, in each environment independently:** deploy a kernel that issues
sealed app secrets ([ima-jin/imajin-ai#2801](https://github.com/ima-jin/imajin-ai/pull/2801)),
then **Sync manifest secrets** for that environment's coffee app on `/jin`, review and sign
the proposal. Otherwise a claimed app fails closed at boot (`SESSION_SECRET unavailable`) and
exits with code 1. A published SDK alone does not mean the target kernel can issue these secrets.

- **Dev:** the dev kernel cannot issue sealed app secrets yet at this adoption step. Keep
  `dev-coffee` on the previous version until the dev kernel supports #2801 and its coffee manifest
  secrets have been synced and signed on the dev `/jin`.
- **Prod:** separately verify the prod kernel supports #2801, then sync and sign the prod coffee
  manifest secrets on the prod `/jin` before upgrading `prod-coffee`. Dev sync does not provision prod.

Use the approved kernel/app deployment tools for this ordering; never generate, copy or put a
session credential in env to bypass the prerequisite.

## The one command

From the target's checkout on the server:

```bash
scripts/deploy.sh dev     # or: scripts/deploy.sh prod
scripts/deploy.sh prod --ref v0.2.0   # a specific tag / sha (this is also the rollback)
scripts/deploy.sh prod --dry-run      # print the plan, execute nothing
```

It is fail-fast: any failure before step 7 stops the deploy and the running process keeps serving the previous
build. The env file is the single source of truth: contract variables exported in the calling shell are ignored
(and listed by name), because `node --env-file` and `pm2 --update-env` would otherwise let a stray `DATABASE_URL`
win. Note that step 2 swaps in the new ref's `deploy.sh`, so a change to the script itself takes effect from the
*next* run.

1. **preflight** — `git`, `node` (>= `.nvmrc`), `pnpm`, `pm2`, `curl` on `PATH`; no local changes to tracked files;
   `.env.local` exists; no stale `pm2` entry of the same name pointing at a different path (see
   [cutover](#one-time-cutover-checklist)).
2. **checkout** — `git fetch --tags --prune`, then `git checkout --detach` the ref (default `origin/main`). Never
   `git pull`.
3. **env check** — `scripts/check-env.mjs <target>` validates `.env.local` for the target (names only, never values).
   See [ENVIRONMENTS.md](./ENVIRONMENTS.md).
4. **install** — `pnpm install --frozen-lockfile`.
5. **build** — `next build` with `.env.local` loaded, so `NEXT_PUBLIC_*` values are baked in.
6. **baseline + migrate** — `scripts/migrate-baseline.mjs` (idempotent; refuses on mismatch), then
   `drizzle-kit migrate` (forward-only). See [Migration baseline](#migration-baseline).
7. **restart** — `pm2 startOrReload ecosystem.config.cjs --only <prod|dev>-coffee --update-env`, then `pm2 save`.
8. **health** — polls `/coffee/api/health` for up to 60 s and requires `"status":"ok"` (includes a DB round-trip and
   the pending-migration check). A non-healthy result exits non-zero.

## First deploy of an environment (fresh checkout)

After the operator steps below are done, it is one command per environment:

```bash
git clone https://github.com/ima-jin/coffee.git ~/prod/coffee && cd ~/prod/coffee
cp .env.prod.example .env.local && chmod 600 .env.local   # then fill in the placeholders
scripts/deploy.sh prod
```

Use `~/dev/coffee` and `.env.dev.example` / `scripts/deploy.sh dev` for dev. Deploy **dev first** and confirm
`https://dev-jin.imajin.ai/coffee/api/health` before touching prod. This repo never deploys itself: a person runs
these commands on the server.

### Operator steps this repo cannot do

Dev and prod are separate identities: each has its own app DID, claim code, keystore and vault-issued session credential.

1. **Mint the app identity** through the kernel's claim flow — see [Identity](../README.md#identity). In short:
   register the app, set the non-secret `IMAJIN_APP_DID`, and deploy. It boots unclaimed if no keystore
   exists. Approve `apps.provision` on `/jin`, then paste its one-time **claim code** in this deployment's
   `/coffee/claim` page. The app writes the 0600 keystore (`IMAJIN_APP_KEYSTORE`) and goes live immediately,
   without an env edit or restart. `check-env.mjs` fails while `IMAJIN_APP_DID` is still the `REPLACE_ME`
   placeholder. No key material is ever written to the repo, the env file, or the logs.
2. **Create the databases/roles** and put the connection strings in each `.env.local`. Prod/dev already contain
   the `coffee` schema with real tips data; the baseline adopts it in place.
3. **Sync the registered manifest through `/jin`** for already-claimed apps: select **Sync manifest secrets**,
   review and sign the proposal. Fresh provision/claim issues and seals declarations automatically.
   Restart through the approved tool; the app loads session credentials from the vault into memory
   with its own keystore identity. No secret env entry or file edit is required. For rotation, select
   **Rotate** on `/jin`, review and sign, then restart; existing sessions are invalidated.
   Unreachable vault or missing declarations fail closed: follow the names-only boot error to re-sync,
   then restart. If the required tool is unavailable, stop rather than working around it.
   The kernel signs payment callbacks; coffee verifies public keys. No shared callback credential is needed.
   Settlement needs no key in the env: coffee settles with its own app-service token. The operator must **approve the
   `pay:settle` service scope for this app's DID** (propose it via `POST /api/apps/service-scopes`, countersign on the
   `apps:service-scopes` card on `/jin`) — until then the token mint drops the scope and pay refuses checkout and settle.
4. **Caddy** — the route already exists; verify it against the [snippet below](#caddy).

### One-time cutover checklist

1. Back up the `coffee` schema (`pg_dump --schema=coffee …`) before the first prod run.
2. `pm2 delete prod-coffee && pm2 save` (and `dev-coffee`) if an old entry still points at the monorepo path
   `~/prod/imajin-ai/apps/coffee`. `deploy.sh` refuses to run while a same-named entry points elsewhere, because
   pm2 would "reload" it with the old script and cwd. Removing old entries is deliberately never automatic.
3. Dry-run the baseline against the real database first:
   `node --env-file=.env.local scripts/migrate-baseline.mjs --dry-run`.
4. `scripts/deploy.sh dev`, verify, then `scripts/deploy.sh prod`.
5. Only after both are verified: clean up the leftover `apps/coffee` folders and the monorepo's pm2 entries on the
   server (a separate, deliberate step).

## Migration baseline

The existing `coffee` schema was created by the monorepo's shared root migrations
(`imajin-ai/migrations/0001_seed.sql`), long before this repo had its own drizzle history. This repo's
`migrations/0000_coffee_schema.sql` creates `coffee.pages` and `coffee.tips` with a bare `CREATE TABLE`, so a plain
`pnpm db:migrate` against prod/dev would fail immediately. `scripts/migrate-baseline.mjs` bridges that:

```bash
node --env-file=.env.local scripts/migrate-baseline.mjs            # baseline (what deploy.sh runs)
node --env-file=.env.local scripts/migrate-baseline.mjs --dry-run  # validate only, write nothing
```

- **Uses the repo's own migrations.** The baseline is the first entry of `migrations/meta/_journal.json`, hashed
  exactly as drizzle-orm hashes it. The "applied" record is drizzle's own tracking table,
  `coffee.__drizzle_migrations` (`migrations` in `drizzle.config.ts`), so `pnpm db:migrate` and `/api/health`
  agree with it and the app writes nothing outside its own schema.
- **Idempotent.** If migration 0000 is already recorded it does nothing and exits 0, so `deploy.sh` runs it every
  time. Running it again is a no-op.
- **Refuses on mismatch.** It introspects the live `coffee` schema (tables, columns, types, nullability, defaults,
  primary/unique keys, foreign keys and their actions, required indexes) and compares it with what migration 0000
  produces. Any difference — missing/extra table or column, wrong type, missing FK or index, or unrecognised
  rows already in the tracking table — exits **1** with a list of the problems and changes nothing. The only
  tolerated differences are constraint *names* (the monorepo seed named the pages primary key
  `coffee_pages_pkey`), column order, and extra indexes. Reconcile the schema by hand; never force it.
- **Never drops, truncates, or alters.** The app's tables are only ever read (`pg_catalog` SELECTs). The only writes
  are `CREATE TABLE IF NOT EXISTS` for drizzle's tracking table and one `INSERT` of the 0000 hash, in one
  transaction under an advisory lock. The test suite asserts this by auditing every statement issued.
- **Fresh databases** (no `coffee` schema, or one with no tables) are left alone: it reports "nothing to baseline"
  with exit 0, and `drizzle-kit migrate` then creates everything.
- Exit codes: `0` ok · `1` refused (mismatch) · `2` usage/config/connection error.

After the baseline, `drizzle-kit migrate` applies only migrations newer than 0000. Migrations are forward-only;
there is no down-migration. New migrations must be additive/guarded (`IF NOT EXISTS`) — see
[MIGRATIONS.md](./MIGRATIONS.md).

## pm2

`ecosystem.config.cjs` defines `prod-coffee` (7100) and `dev-coffee` (3100), following the links/dykil precedent.
Each entry execs `node_modules/next/dist/bin/next start -p <port>` directly (never `npm start` — imajin-ai#2447:
pm2 would track the npm wrapper and orphan `next-server` on restart), loads `.env.local` with `node --env-file`
(Node exits if the file is missing, so a coffee with no env crashes loudly instead of booting without its
identity), uses this checkout as `cwd`, and logs to `~/.pm2/logs/<name>-out.log` / `<name>-error.log`. A checkout
only ever starts its own entry (`--only`).

```bash
pm2 logs prod-coffee --lines 100     # stdout (the app logs to stdout only)
pm2 describe prod-coffee
```

## Caddy

The route is unchanged from the monorepo era. The app is mounted under the `/coffee` basePath and Caddy must
forward the prefix **intact** — use `handle`, not `handle_path` (which strips it):

```caddy
# prod — inside the existing jin.imajin.ai site block
jin.imajin.ai {
    @coffee path /coffee /coffee/*
    handle @coffee {
        reverse_proxy localhost:7100
    }
    # ...the rest of the site (kernel and other apps) unchanged
}

# dev — inside the existing dev-jin.imajin.ai site block
dev-jin.imajin.ai {
    @coffee path /coffee /coffee/*
    handle @coffee {
        reverse_proxy localhost:3100
    }
}
```

Verify: `curl -fsS https://jin.imajin.ai/coffee/api/health` → `{"status":"ok","service":"coffee",…}`.

## Kernel-signed payment callbacks

Deploy a kernel that signs callbacks before upgrading this receiver. The kernel signs; coffee verifies
with `verifyKernelWebhook` from `@ima-jin/auth/kernel-webhook` (published SDK 0.8.18). No shared
callback credential is provisioned, generated or copied. The trusted local `IMAJIN_APP_DID` is the
recipient audience; `AUTH_SERVICE_URL` points at this environment's kernel auth service. The SDK
discovers public keys at `{AUTH_SERVICE_URL}/.well-known/kernel-signing-key` over HTTPS and pins
them on first use. Subsequent rotation requires overlap with pinned keys; never delete pins to
work around a trust failure.

Keep `data/kernel-webhook-pins/` under the process cwd on persistent, writable storage, separate
per environment and preserved across deploys/rollbacks. These files contain only public keys.
The host must supply trusted Linux `/usr/bin/flock` (util-linux); missing tooling, discovery or
storage failures fail closed with 503 and no business processing. Signature, audience, freshness
and replay failures return 401; correctly signed non-JSON bodies return 400.

The existing pm2 entry uses one fork worker. The SDK's atomic process-wide nonce store rejects
duplicate deliveries within its inclusive ±300-second freshness window. Retries need a new nonce
and signature. Replay memory does not survive a process restart: to retain replay evidence across
restarts, or **before adding workers/replicas**, inject a shared durable
`KernelWebhookNonceStore` via the verifier's `nonceStore` option, with atomic insert-if-absent and
expiry semantics. Do not scale this configuration without that adapter.

The signed path includes the public `/coffee` prefix and query string. Caddy must keep that prefix
intact as above; neither proxy nor app may rewrite signed body bytes or signature headers.

## Rollback

Redeploy the previous tag or sha: `scripts/deploy.sh prod --ref <previous-tag>`. Migrations are forward-only, so a
rollback is only safe while migrations stay additive (the same stance as imajin-ai's `docs/ops/ROLLBACK.md`).

## Troubleshooting

- **`baseline` exits 1** — the message lists exactly what differs. Do not edit the script to force it; fix the schema
  (or tell the app owner the schema drifted), then re-run.
- **`env check` fails** — each line names a variable; see [ENVIRONMENTS.md](./ENVIRONMENTS.md).
- **Health reports `claimed: false`** — the app is booted but unclaimed. Approve provisioning on `/jin` and
  redeem the code on this deployment's `/coffee/claim` page. Dev and prod have separate DIDs and keystores.
- **Keystore lost** — the app boots unclaimed. Ask the kernel operator to re-approve `apps.provision` with
  `reissueClaim: true`, then redeem the fresh code on `/coffee/claim` (this revokes the lost bootstrap key).
- **Health reports `degraded`** — committed migrations are not yet recorded as applied; re-run the deploy (or
  `scripts/migrate-baseline.mjs` then `pnpm db:migrate`).
- **Login loops on dev only** — `IMAJIN_ENV=dev` is missing (wrong session cookie name).
- **`/dashboard` redirects to `kernel.imajin.ai`** — `NEXT_PUBLIC_KERNEL_URL` was not set; set it and redeploy.
