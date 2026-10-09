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
| `POST /api/webhook/payment` | `WEBHOOK_SECRET` bearer | constant-time compare; called by the pay service |

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

## Behaviour that differs from the kernel version (each tracked as a kernel gap)

- **No bus events.** The kernel published `tip.granted` / `tip.sent` to the in-process bus. The bus is kernel-internal and
  has no app-callable HTTP surface, so coffee does not emit them — [ima-jin/imajin-ai#2641].
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
