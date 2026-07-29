# Production runbook - Canari <-> Le Cercle link

How to configure, then verify, the two-way link between Canari and Le Cercle on the real hosts.
Everything below assumes real addresses and real secrets; nothing here is a dry run.

Related: [`docs/wiki/cotisations.md`](wiki/cotisations.md) for how tiers and tags work,
`../le-cercle/README.md` for the Cercle side.

## What is already proven, and what is not

The link was certified end to end on 2026-07-28 - 27 automated checks against a faithful HTTP stub
of `GET /api/public/cotisant-status`, including: the 15-minute snapshot TTL, the 24-hour grace
window, live-tier-driven alcohol gating, a tier downgrade taking effect on the next round,
`tier: null` failing closed to sans-alcool, revocation locking the user out on the next request, an
expired snapshot overriding a stale `isCotisant`, and a signed webhook crediting exactly once when
replayed, with zero ledger drift throughout.

Three things a stub cannot prove, and which this runbook exists to check:

1. Canari's real `cotisant-status` answers the shape the Cercle parses, over real TLS, with the real
   API key and the real 20 req/min throttle.
2. A real OIDC login through MiConnect produces a `sub` that IS the Canari `userId` - the whole link
   keys on that identity, and the certification minted its own cookies.
3. Canari's real webhook dispatcher (3 attempts, `X-Canari-Signature: sha256=<hex>` over the exact
   bytes it sent) reaches the Cercle and is accepted.

## The real addresses

| What | Value |
| --- | --- |
| Canari | `https://canari-emse.fr` |
| Canari cotisant endpoint | `GET https://canari-emse.fr/api/public/cotisant-status?assoSlug=<slug>&sub=<userId>` |
| Cercle webhook endpoint | `POST https://<cercle-host>/api/canari/topup` |
| OIDC issuer | `https://auth.canari-emse.fr/application/o` |
| OIDC JWKS | `https://auth.canari-emse.fr/application/o/cercle/jwks/` |
| Canari host | `ssh canari`, compose project `infrastructure-*` |

`<cercle-host>` is the only value not yet fixed - fill it in when the Cercle is deployed, and set it
as the `balance_topup` product's `webhookUrl` (see step 3).

## Secrets, and which name they wear on each side

The same secret has a different variable name on each end. Getting this backwards is the single
most likely setup mistake.

| Secret | On Canari | On Le Cercle | Generate |
| --- | --- | --- | --- |
| Cotisant-status API key | `CERCLE_API_KEY` in `infrastructure/.env` | `CANARI_API_KEY` in `.env` | `openssl rand -hex 32` |
| Webhook signing secret | `webhookSecret` on the `balance_topup` product (in the database, set from the UI) | `CANARI_WEBHOOK_SECRET` in `.env` | `openssl rand -hex 32` |
| Session key | - | `SESSION_SECRET` in `.env` | `openssl rand -base64 48` |
| OIDC client | Authentik application `cercle` | `MICONNECT_CLIENT_ID` / `MICONNECT_CLIENT_SECRET` | Authentik |

`CERCLE_API_KEY` empty on Canari means the endpoint rejects every request (the comparison is
timing-safe and an empty expected value never matches) - it is not an "open" default.

The Cercle's working `.env` currently holds throwaway placeholders for `SESSION_SECRET` and
`CANARI_WEBHOOK_SECRET`. Both MUST be regenerated for production. Rotating `SESSION_SECRET` is also
the only way to revoke every Cercle session at once.

## Setup

### 1. Canari: the API key

On the Canari host, set `CERCLE_API_KEY` in `infrastructure/.env`, then recreate social-service:

```sh
ssh canari
cd infrastructure
# edit .env
docker compose -f docker-compose.prod.yml up -d social-service
```

Also set it as a GitHub secret if the deployment pipeline injects it.

### 2. Canari: the association and its tiers

The Cercle association must have a `cotisationMode` (lifetime or dated) and its membership tiers
created, in **Association -> Cotisations**:

- `avec-alcool` and `sans-alcool` are the two tier identifiers the Cercle understands. They are the
  `variantKey` field ("Identifiant du palier"), not the display name.
- **Do not delete the auto-provisioned base tier - convert it.** Editing a tier's `variantKey`
  re-derives its tag and renames every `user_tags` row holding the old one, in the same
  transaction, so existing cotisants follow. Deleting a tier does NOT migrate its holders' tags:
  they would keep an orphan tag and report `tier: null`, which the Cercle fails closed to
  sans-alcool. So: rename the base tier to `sans-alcool` (or `avec-alcool`, whichever the existing
  cotisants actually paid for), then add the other one.
- A cotisant holds exactly one tier: granting or buying one revokes the siblings in the same
  transaction. There is no way to hold both.
- `CANARI_ASSO_SLUG` on the Cercle side must equal the association's slug in Canari (`le-cercle`
  unless it was renamed).

Check the tier setup from the outside before going further:

```sh
curl -s -H "X-Api-Key: $CERCLE_API_KEY" \
  "https://canari-emse.fr/api/public/cotisant-status?assoSlug=le-cercle&sub=<a-real-cotisant-userId>"
```

Expected: `{"isCotisant":true,"tier":"avec-alcool","expiresAt":"2026-08-31T..."}` -
`tier` must be a **named** key. A `null` tier on a real cotisant means the base tier was never
converted, and every one of them will be treated as sans-alcool.

Then check it fails closed: same call with a bogus key must be `403`, and with a non-cotisant `sub`
must be `{"isCotisant":false,"tier":null,"expiresAt":null}` - not a 404.

### 3. Canari: the `balance_topup` product (WP-INT-1)

`balance_topup` products live at **`/admin/cercle`**, global admin only - not in the association's
own Cotisations tab, and the restriction is enforced server-side, not just by the route. There, on
the Cercle's top-up product, set:

- `webhookUrl` = `https://<cercle-host>/api/canari/topup`
- `webhookSecret` = the generated secret, identical to the Cercle's `CANARI_WEBHOOK_SECRET`

The secret is per-product data in the database, not an environment variable. Both fields must be
non-empty or the dispatch is silently skipped: the fulfillment only calls `dispatchCercleWebhook`
when `webhookUrl && webhookSecret && stripePaymentIntentId` are all set.

`/admin/cercle` is also where failed deliveries are listed and retried, which is what step V5 falls
back on.

### 4. Le Cercle: environment

```sh
DB_PATH=<persistent path, outside the deploy directory>
SESSION_SECRET=<openssl rand -base64 48>
MICONNECT_ISSUER=https://auth.canari-emse.fr/application/o
MICONNECT_JWKS=https://auth.canari-emse.fr/application/o/cercle/jwks/
MICONNECT_CLIENT_ID=<from Authentik>
MICONNECT_CLIENT_SECRET=<from Authentik>
CANARI_INTEGRATION_ENABLED=true
CANARI_BASE_URL=https://canari-emse.fr
CANARI_ASSO_SLUG=le-cercle
CANARI_API_KEY=<same value as CERCLE_API_KEY on Canari>
CANARI_WEBHOOK_SECRET=<same value as the product's webhookSecret>
```

`CANARI_INTEGRATION_ENABLED=false` is a development switch only. In production it would freeze the
cotisant snapshot at whatever it last was and never refresh it - it does not open the access gate,
but it does make every gate decide on stale data forever.

Then, on the Cercle host: `bun run db:migrate` (idempotent, replays against `PRAGMA user_version`),
and back up `DB_PATH` before the first real service - the ledger is the only record of who owes
what.

## Verification, in order

Each step depends on the one before it. Stop at the first failure; a later step passing on top of a
broken earlier one proves nothing.

### V1 - OIDC round trip and identity

Log in as a real cotisant through MiConnect. Expect: redirected in, no `/unauthorized`.

Then, on the Cercle host, confirm the identity is the shared one:

```sh
sqlite3 "$DB_PATH" "SELECT uuid, first_name, is_cotisant, tier, cotisation_synced_at FROM users ORDER BY rowid DESC LIMIT 3;"
```

`uuid` must be the same string as the user's Canari `userId`. If it is not, nothing downstream can
work: the Cercle asks Canari about `sub`, and Canari looks that up as its own primary key.

`cotisation_synced_at` must be set - the login callback forces a sync rather than waiting for the
TTL, precisely so a first login does not bounce a genuine cotisant.

### V2 - The access gate

- A real cotisant: gets in.
- A member of neither kind (no cotisation, not cercleux): bounced to `/unauthorized`.
- A cercleux with no cotisation: gets in, but any attempt to consume is refused with "not a
  cotisant". Site access and the right to consume are two different rights, by design.

### V3 - The TTL actually holds

This is the one that was broken until `7e87b61` (SQLite writes bare UTC, `new Date()` read it as
Paris local, so every snapshot looked two hours old and every single request re-queried Canari -
against a 20 req/min throttle).

Load three or four Cercle pages in a row as the same user, then read Canari's logs:

```sh
ssh canari
docker compose -f infrastructure/docker-compose.prod.yml logs --tail=200 social-service | grep 'cotisant-status'
```

Expect **one** `[CERCLE] cotisant-status` line for the whole burst (plus one for the login), not one
per page. More than that means the snapshot is not being read as fresh, and the throttle will start
returning 429 during a busy perm.

### V4 - The alcohol gate, driven live from Canari

With a perm open and a bartender logged in:

1. Charge an alcoholic item to an `avec-alcool` cotisant - accepted, balance debited by the price
   set for **that perm** (the server price, never the submitted one).
2. Charge the same item to a `sans-alcool` cotisant - refused, "alcohol forbidden", no ledger row.
3. In Canari, move the first user to `sans-alcool` (grant the other tier - the XOR revokes the old
   one), then charge the alcoholic item again. The consumption path re-checks Canari live (it does
   not trust the snapshot for money), so it must be refused on the very next round, with no wait.
4. Revoke the cotisation entirely in Canari. Next request: refused, and the next page load bounces
   to `/unauthorized`.

### V5 - The recharge webhook

Buy the `balance_topup` product from Canari with a real (small) Stripe payment.

On Canari:

```sh
docker compose -f infrastructure/docker-compose.prod.yml logs --tail=100 social-service | grep CERCLE
```

Expect `[CERCLE] webhook delivered: product=... attempt=1`. If all three attempts fail (delays 1s,
5s, 15s), the delivery is recorded in `webhook_deliveries` with its error and can be retried from
`/admin/cercle` once the cause is fixed - the payment is not lost.

On the Cercle: the balance must have moved by exactly `amountCents`, with one `topup` movement in
`account_movements` whose `idempotency_key` is the Stripe payment intent.

Then prove the idempotency, because Canari retries: replay the exact same body and signature.

```sh
BODY='<the exact body from the delivery record>'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$CANARI_WEBHOOK_SECRET" -hex | awk '{print $2}')
curl -si -X POST "https://<cercle-host>/api/canari/topup" \
  -H 'Content-Type: application/json' -H "X-Canari-Signature: sha256=$SIG" --data "$BODY"
```

Expect `200`, and the balance **unchanged**, with no second movement. Then flip one character of
the signature and repeat: expect `401` and, again, no movement.

### V6 - Ledger integrity

At the end of the session, on the Cercle host:

```sh
sqlite3 "$DB_PATH" "
SELECT u.uuid, u.balance, COALESCE(SUM(m.amount_cents), 0) AS ledger
FROM users u LEFT JOIN account_movements m ON m.uuid_user = u.uuid
GROUP BY u.uuid HAVING u.balance <> ledger;"
```

Must return nothing. `users.balance` is a cache of the append-only ledger, written in the same
transaction; any row here is a bug, not a rounding artefact.

Note the ledger has no reversal movement, so **a drink charged to the wrong account cannot be
undone today**. Say so to the bar staff before the first real perm.

## If something fails

| Symptom | Look at |
| --- | --- |
| Everyone bounced to `/unauthorized` | `CANARI_API_KEY` vs `CERCLE_API_KEY`; `CANARI_ASSO_SLUG`; Canari logs for `403` on `cotisant-status` |
| Every cotisant treated as sans-alcool | the base tier was never converted - `tier` comes back `null` and fails closed |
| `429` from Canari under load | the TTL is not holding - see V3 |
| Webhook never arrives | `webhookUrl`/`webhookSecret` empty on the product, or the Cercle host unreachable from the Canari container |
| Webhook arrives but `401` | the two secrets differ, or a proxy re-serialized the body (the signature is over the exact bytes sent) |
| Balance credited twice | the idempotency key is not the payment intent - check `account_movements.idempotency_key` |
