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

Dev and prod are separate identities: each has its own app DID, claim code, keystore and `SESSION_SECRET`.

1. **Mint the app identity** through the kernel's claim flow — see [Identity](../README.md#identity). In short:
   register the app and approve `apps.provision` on `/jin` to get a one-time **claim code**, put it in
   `.env.local` as `IMAJIN_APP_CLAIM_CODE` together with `IMAJIN_APP_DID`, and deploy. On that first boot
   `instrumentation.ts` spends the code and writes the 0600 keystore (`IMAJIN_APP_KEYSTORE`). **Then delete
   `IMAJIN_APP_CLAIM_CODE` from `.env.local`.** `check-env.mjs` warns while it is still set and fails while
   `IMAJIN_APP_DID` is still the `REPLACE_ME` placeholder. No key material is ever written to the repo, the env
   file, or the logs.
2. **Create the databases/roles** and put the connection strings in each `.env.local`. Prod/dev already contain
   the `coffee` schema with real tips data; the baseline adopts it in place.
3. **Fill in the secrets** — `SESSION_SECRET` (`openssl rand -hex 32`), `WEBHOOK_SECRET` (must equal the matching
   pay service's), and `PAY_SERVICE_API_KEY` where settlement should run.
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

## Rollback

Redeploy the previous tag or sha: `scripts/deploy.sh prod --ref <previous-tag>`. Migrations are forward-only, so a
rollback is only safe while migrations stay additive (the same stance as imajin-ai's `docs/ops/ROLLBACK.md`).

## Troubleshooting

- **`baseline` exits 1** — the message lists exactly what differs. Do not edit the script to force it; fix the schema
  (or tell the app owner the schema drifted), then re-run.
- **`env check` fails** — each line names a variable; see [ENVIRONMENTS.md](./ENVIRONMENTS.md).
- **Health never goes green on a first boot** — `pm2 logs <name>`: a used/rejected `IMAJIN_APP_CLAIM_CODE`, a
  missing code with no keystore, or a wrong `IMAJIN_APP_DID` fails at `instrumentation.ts`. The dev and prod
  instances must each have their own DID, claim code and keystore.
- **Restart after a lost keystore fails** — ask the kernel operator to re-approve `apps.provision` with
  `reissueClaim: true` for a fresh code (redeeming it also revokes the lost keystore's bootstrap key).
- **Health reports `degraded`** — committed migrations are not yet recorded as applied; re-run the deploy (or
  `scripts/migrate-baseline.mjs` then `pnpm db:migrate`).
- **Login loops on dev only** — `IMAJIN_ENV=dev` is missing (wrong session cookie name).
- **`/dashboard` redirects to `kernel.imajin.ai`** — `NEXT_PUBLIC_KERNEL_URL` was not set; set it and redeploy.
