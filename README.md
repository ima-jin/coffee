# coffee — a third-party app on Imajin

> Forked from [`ima-jin/imajin-app-template`](https://github.com/ima-jin/imajin-app-template). **Read
> [`AGENTS.md`](./AGENTS.md) first** — it defines the boundary this app must not cross.

**Platform:** [Imajin](https://imajin.ai) (sovereign-tech kernel) · **Reference app:** `ima-jin/imajin-scorecard`

This repository **is the app** — a real, arms-length third-party application that composes the Imajin platform
**only through its public app surface** (`requireAppAuth` + the documented kernel API). It holds **no `workspace:*`
deps, no monorepo internals, no DB access, no in-process bus** — it talks to Imajin as an external client. Published
`@ima-jin/*` SDK packages (from npmjs.org, no auth needed) are fine to depend on; they're the same versioned
artifact every app — first-party or third-party — consumes.

## Source of truth is the user's

This app holds nothing authoritative. The signed records are **the user's own**, on their per-DID path. The kernel is
the authoritative **index/projection** of those records — not their owner. The user can walk with their records and
everything still verifies. (See `AGENTS.md` §3.)

## How it composes Imajin

| Header | Meaning |
|--------|---------|
| `X-App-DID` | this app's DID (from registration) |
| `X-App-Authorization` | the attestation ID from the user's consent flow |

The kernel verifies both and returns `{ appDid, userDid, scopes }` — that triple is the app's entire authority.

## Getting started

1. **Use this template** (GitHub's "Use this template" button, or `git clone` + a new remote).
2. **Register this app with the kernel** — see [`docs/REGISTRATION.md`](./docs/REGISTRATION.md).
   You'll get back this app's `appDid` and registry `id`.
3. **Set env**: `cp .env.example .env.local`, then fill in `IMAJIN_APP_DID`,
   `NEXT_PUBLIC_IMAJIN_APP_ID`, `SESSION_SECRET`, `APP_DB_SCHEMA`, `DATABASE_URL`, `IMAJIN_KERNEL_URL`,
   and (first boot only) `IMAJIN_APP_CLAIM_CODE`. This app refuses to start without `IMAJIN_APP_DID`
   set, or if a raw `IMAJIN_APP_PRIVATE_KEY` is present (see `instrumentation.ts`) — it fetches its
   own signing key at boot via `@ima-jin/auth-client`'s `loadAppSigningKey()` instead; see
   [`docs/REGISTRATION.md`](./docs/REGISTRATION.md).
4. **Migrate this app's own database** (its own Postgres schema only — see
   [`docs/MIGRATIONS.md`](./docs/MIGRATIONS.md)):
   ```bash
   pnpm install
   pnpm db:migrate
   ```
5. **Run it**:
   ```bash
   pnpm dev
   ```
   `/api/health` and `/api/spec` should respond immediately; `/api/me` returns your DID once
   you sign in through the header's "Sign in with Imajin" link.

## Identity

Each deployment (dev, prod) is its own app identity — its own DID, keystore and claim code — minted through
the kernel's claim flow. Nothing is hand-made, and no key material ever lands in the repo, the env file or the logs.

1. **Register the app** with the kernel and note the returned `appDid` and registry `id`
   ([`docs/REGISTRATION.md`](./docs/REGISTRATION.md) §1–2). Set `IMAJIN_APP_DID` and `NEXT_PUBLIC_IMAJIN_APP_ID`
   in the target's `.env.local`.
2. **Mint a claim code** (operator step, on the kernel): open the `apps.provision` approval card on `/jin` for this
   app and approve it. It yields a **one-time claim code**. Use `reissueClaim: true` to get a fresh one after a
   lost keystore.
3. **Spend it on first boot.** Put the code in `.env.local` as `IMAJIN_APP_CLAIM_CODE` and start the app (the
   normal [deploy](#deploy) does this). `instrumentation.ts` calls `@ima-jin/auth-client`'s `loadAppSigningKey()`,
   which redeems the code together with a freshly minted bootstrap keypair, and persists only that bootstrap
   keypair in the `0600` keystore (`IMAJIN_APP_KEYSTORE`). The signing key itself is memory-only.
4. **Delete `IMAJIN_APP_CLAIM_CODE`** from `.env.local` once the app is up — it is spent. Every later boot
   re-authenticates with the keystore alone, so ordinary restarts need no operator action.

> **No `/claim` page yet.** Coffee does not (yet) have the operator `/claim` page that `ima-jin/links` and
> `ima-jin/dykil` ship (links#4, dykil#7), where the code is pasted into the running app instead of the env file.
> Until that is ported, the claim code is spent from `IMAJIN_APP_CLAIM_CODE` at boot as described above — the same
> kernel claim flow, minus the page. See `docs/DEPLOY.md`.

## Deploy

Coffee runs as its own pm2 process on the kernel host (`prod-coffee` :7100, `dev-coffee` :3100) behind the
unchanged Caddy `/coffee` route. From the target's checkout (`~/prod/coffee` or `~/dev/coffee`) on the server:

```bash
scripts/deploy.sh dev    # or: scripts/deploy.sh prod   (add --dry-run to print the plan, --ref <tag> to pin/rollback)
```

It checks out the ref, validates `.env.local` (`scripts/check-env.mjs`), installs, builds, runs the idempotent
[migration baseline](./docs/DEPLOY.md#migration-baseline) + `drizzle-kit migrate`, reloads pm2, and gates on
`/coffee/api/health`. First-deploy steps, the Caddy snippet, the cutover checklist and rollback are in
[`docs/DEPLOY.md`](./docs/DEPLOY.md); every environment variable is documented in
[`docs/ENVIRONMENTS.md`](./docs/ENVIRONMENTS.md) (`.env.example`, `.env.dev.example`, `.env.prod.example`).

## Consuming `@ima-jin/*`

Published `@ima-jin/*` packages (e.g. `@ima-jin/auth-client`, `@ima-jin/config`, `@ima-jin/ui`) are served from
npmjs.org, the default registry — no `.npmrc` scoping and no auth token needed to install them:

```bash
pnpm add @ima-jin/auth-client
```

## Layout

```
AGENTS.md          ← boundary + scope for coding agents (read first)
README.md          ← this file
docs/
  ARCHITECTURE.md  ← design notes
  REGISTRATION.md  ← how to register this app with the kernel
  MIGRATIONS.md    ← this app's schema-ownership rule
  DEPLOY.md        ← deploy runbook: one command, baseline, pm2, Caddy, cutover
  ENVIRONMENTS.md  ← every env var, dev vs prod
scripts/           ← deploy.sh, check-env.mjs, migrate-baseline.mjs (+ tests)
ecosystem.config.cjs ← pm2 entries: prod-coffee (7100), dev-coffee (3100)
app/               ← Next.js App Router: pages + API routes
src/
  components/      ← client components
  lib/             ← auth config, signing-identity (loadAppSigningKey boot path), base-path, other helpers
  db/              ← this app's own drizzle schema (never a kernel schema)
migrations/        ← generated by `pnpm db:generate`, applied by `pnpm db:migrate`
api-spec/          ← this app's own OpenAPI document, served at /api/spec
instrumentation.ts ← boot-env guards + loadAppSigningKey() bootstrap (see docs/REGISTRATION.md)
```

## This app's own signing key

This app never reads a raw private key from env. `instrumentation.ts` fails loud at boot if
`IMAJIN_APP_PRIVATE_KEY` is set, and instead calls `@ima-jin/auth-client`'s `loadAppSigningKey()`:
a one-time claim code (`IMAJIN_APP_CLAIM_CODE`) bootstraps a local `0600` keystore
(`IMAJIN_APP_KEYSTORE`) on first boot; every later boot re-authenticates with that keystore, no
operator action needed. See [`docs/REGISTRATION.md`](./docs/REGISTRATION.md#4-fetch-this-apps-own-signing-key-at-boot-7).

## Mounting under a path prefix

Set `NEXT_PUBLIC_BASE_PATH` (e.g. `/coffee`) when this fork is served behind a reverse-proxy path
prefix instead of at `/`. `next.config.js` reads it for Next's own `basePath` (covers `<Link>` and
`router.push` automatically); route any raw `fetch()`, `<a href>`, or `redirect()` through
`src/lib/base-path.ts`'s `withBasePath()` helper, since Next.js doesn't rewrite those.

## The honest test

Every Imajin app before the external integrators was first-party (same repo, same server, privileged access). Apps
built from this template are the **external-integrator** test: if this app can do everything it needs through app-auth
and the public API alone, the federated-app boundary is real.
