# Architecture — Coffee

> This app is a **lens** over the user's signed records. It owns no authoritative state. See `AGENTS.md` §1–§3.

## The three-tier projection model

| Tier | What | Owns truth? |
|------|------|-------------|
| **User's signed records** | signed markdown/attestations on the user's per-DID path (hosted now, user-held vault later) | ✅ source of truth |
| **Kernel domain core** | domain events / stage tables / settlement primitive | ❌ derived projection |
| **Connectors** | user-selected services (QuickBooks, …) feeding the user's records | ❌ user's instruments |
| **This app** | render + gesture UX + connector-select | ❌ a lens |

## Integration contract

External client only — app-auth headers (`X-App-DID` + `X-App-Authorization`) → kernel returns
`{ appDid, userDid, scopes }`. No `workspace:*` deps, no monorepo internals, no DB, no in-process bus. Published
`@ima-jin/*` SDK packages (npmjs.org, no auth needed) are fine — see `AGENTS.md` §2. Domain events are emitted by calling the
kernel's app-auth-gated domain API.

## Deploy convention

Each fork deploys as its own pm2 ecosystem entry behind a Caddy route (`Host` header → this app's port), the same
shape as every other app on the platform. Neither pm2 config nor the Caddy route is copied from the monorepo — the
monorepo's `deploy-dev.yml`/`deploy-prod.yml` assume shared infra (self-hosted runners, its own secrets) that doesn't
transfer to a standalone fork. Wire your own deploy workflow against your fork's runner/secrets when you're ready to
ship; this convention only fixes the shape (one pm2 entry, one Caddy route) so it stays consistent across apps.

## The loop this app instruments

Supporter → page owner, one paid leg (the tip). A page owner publishes a tip page (`/{handle}`); a supporter picks an
amount and pays by card (Stripe Checkout via the kernel's pay service) or Solana (direct transfer to the page's
address). The pay service calls back `POST /api/webhook/payment`; coffee marks the tip completed and asks pay to settle
the `.fair` split (creator + platform fee) with its own app-service token. Settlement is idempotent across webhook
redelivery (`tips.settled_at`, plus the kernel's `alreadySettled`).

## Routes (ported from the kernel's `apps/coffee` at parity)

| Route | Auth | Notes |
|-------|------|-------|
| `GET /api/health` | none | own migration state from this app's own DB |
| `GET /api/spec` | none | serves `api-spec/openapi.yaml` |
| `POST /api/pages` | app token / session | one page per DID; builds the `.fair` manifest from the registry's public node config |
| `GET /api/pages/mine` | app token / session | the #1974 reference adoption |
| `GET /api/pages/{handle}` | none | 403 for private pages |
| `PUT` / `DELETE /api/pages/{handle}` | app token / session | owner only |
| `POST /api/tip` | optional | anonymous tips allowed; attributed to the caller's DID when authenticated |
| `POST /api/checkout` | none | page-less support checkout (min $5) |
| `GET /api/tips/{did}` | app token / session | owner only |
| `POST /api/webhook/payment` | kernel Ed25519 signature | SDK verifies app DID, raw body, method/path/query, timestamp and nonce before business side effects |

## Auth: the app-token contract (#1974)

Every authenticated route calls `authenticate()` (`src/lib/auth/authenticate.ts`) and nothing else — no route imports an
auth primitive directly. It runs `requireSessionOrAppToken` from the published `@ima-jin/auth` with `slug: 'coffee'`
(`IMAJIN_APP_AUD` overrides it) — the audience is coffee's registry slug, never a host, because every path-routed app
shares one host (#2706); a token minted for another app can never verify here. In order:

1. `Authorization: Bearer <scoped app token>` — minted by the browser (`src/lib/client/app-fetch.ts`) from the user's
   kernel session via `POST {kernel}/auth/api/tokens/app`, verified against the kernel.
2. The shared kernel session cookie (migration fallback, same adapter call).
3. This app's own "Sign in with Imajin" cookie (`@ima-jin/auth-client`'s `getSession`) — what a split-domain deployment
   actually has.

No coffee-specific scopes are required (the kernel clamps requested scopes to its closed vocabulary).
`AUTH_SERVICE_URL` (kernel auth service, `/auth` prefix) is what `@ima-jin/auth` reads to verify tokens.

## Domain events

Coffee emits `tip.granted` and `tip.sent` via `POST {IMAJIN_KERNEL_URL}/api/events`,
not an in-process bus. `imajin.app.json` declares both in `emittableEvents`, which
the kernel reads into the `/jin` provision/declarations preview. Declaration is
not approval: the operator must approve the types separately for each app DID.

The existing server-only token helper proves possession of coffee's claimed key
at `POST {IMAJIN_KERNEL_URL}/auth/api/apps/token/service` and caches the returned
app-service token. Its default `imajin:apps` audience is accepted by the events
route. No user token, shared secret, new environment variable or publish-path
switch is used. `IMAJIN_KERNEL_URL` must be the kernel base URL (no `/auth` or
`/pay` prefix); `IMAJIN_APP_DID` and the claimed signing identity are required.
Missing configuration produces an error-level diagnostic naming the setting.

After an authenticated pending tip is inserted, `/api/tip` emits `tip.granted`
with `status: pending` (the pre-split behavior, not proof of payment). After a
successful payment callback commits completion, coffee emits recipient
`tip.granted` and, for an identified sender, `tip.sent`, with `status: completed`.
Amounts, currency and identities come from stored tip/page data. Anonymous tips
still notify the recipient when completed. Payloads keep `context_id`,
`context_type`, notification names and `interestDids`; `correlationId` is the tip
ID. The kernel supplies the app issuer/origin and fixed scope.

Each HTTP attempt has a five-second timeout. Publishing is awaited but
best-effort: 401/403/429, transport failures and mint failures are logged without
changing payment responses or settlement behavior. A 401 drops the cached
token for the next attempt. No automatic event retries/outbox are provided;
webhook redelivery can repeat notifications, and correlation IDs are for tracing,
not a kernel deduplication guarantee. Logs omit tokens, signatures, arbitrary
response bodies and raw transport errors.

Accepted app events run **notify and audit only**. They never settle money,
emit MJN or issue attestations. Payment settlement remains a separate API call.
After deployment, the operator must approve both declared types on prod and dev
`/jin`, then confirm a completed tip reaches notify and the kernel audit log with
coffee's app DID. This is an operator step, not part of CI or this change.

## Behaviour that differs from the kernel version

- **Settlement is app-token based.** Coffee mints its own app-service token (`POST {kernel}/auth/api/apps/token/service`,
  proof of possession with the app key), sends it on `POST {pay}/api/checkout` together with a `payeeManifest` (so
  `pay.transactions.app_did` is coffee's DID; the returned `transactionId` is stored on the tip), then settles with
  `POST {pay}/api/settle` `{ transaction_id, fair_manifest: { chain } }` once the webhook confirms payment. The chain
  posted is the stored payee manifest (the kernel answers 403 on any mismatch); `alreadySettled: true` is success, 409
  means the payment is not completed yet. Needs the operator-approved `pay:settle` service scope for coffee's app DID —
  [ima-jin/imajin-ai#2642], [ima-jin/coffee#8].
- **No act-as.** App tokens cannot carry a group DID, so the acting identity is always the authenticated DID and the
  forest scope fee is never applied — [ima-jin/imajin-ai#2644].
- **Browser token mint is inlined.** `@ima-jin/auth-client` has no browser-safe entry — [ima-jin/imajin-ai#2643].
- The kernel's `NavBar`/hub chrome is not rendered; this app keeps the template header with "Sign in with Imajin".
- The kernel's unused `src/lib/email.ts` templates were not ported (nothing called them; `@ima-jin/email` is unpublished).

## Pre-existing quirks preserved on purpose (parity, not endorsement)

- `PUT /api/pages/{handle}` ignores `fundDirections` (the edit form sends it; the kernel route never persisted it).
- `POST /api/tip` forwards `fundDirection` to pay as metadata but does not store it on the tip row.

## Open decisions

- Whether to adopt the `X-App-DID` / `X-App-Authorization` proof-of-possession flow instead of host-scoped session
  tokens (`authenticate()` is the single seam to change).
