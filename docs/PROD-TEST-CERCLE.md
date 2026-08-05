# Production runbook - Canari <-> Le Cercle link

How to configure, then verify, the two-way link between Canari and Le Cercle on the real hosts.
Everything below assumes real addresses and real secrets; nothing here is a dry run.

Related: [`docs/wiki/cotisations.md`](wiki/cotisations.md) for how tiers and tags work,
`../le-cercle/README.md` for the Cercle side.

## What is already proven, and what is not

**Both directions now work against the real hosts (measured 2026-08-03).** What each step below
established, and what is still owed, is recorded in the step itself. The short version:

| | Status |
| --- | --- |
| Outbound webhook (Canari -> Cercle), incl. idempotency and rejection cases | **PASS** |
| `cotisant-status` (Cercle -> Canari), incl. named tiers and failure modes | **PASS** |
| Shared identity (`sub` = Canari `userId` = Cercle `users.uuid`) | **PASS**, but see V1 |
| A real MiConnect OIDC round trip | **owed** - needs a browser |
| The access gate and the alcohol gate at a real till | **owed** - needs an open perm |

The link had been certified on 2026-07-28 against an HTTP stub (27 checks). That certification is
now largely historical: the Cercle side was rewritten afterwards, and its snapshot columns, its TTL
and its `account_movements` table no longer exist. Trust the steps below, not the stub run.

Two traps this runbook exists to catch, both of which DID fire on the first live attempt:

1. A missing route answers a SvelteKit **HTML 404**, which the dispatcher records as an ordinary
   failure - "the webhook does not work" and "the webhook is not deployed" look identical from
   Canari.
2. The receiver must strip the **`sha256=` prefix** before decoding the signature. Without it,
   `Buffer.from('sha256=<hex>', 'hex')` yields an empty buffer and every delivery is a 401 - which
   reads exactly like a secret mismatch and sends you comparing secrets that were never wrong.

## The state of that host, as of 2026-08-04

Verified by fingerprint, not assumed. These are things to **raise with Aurel**, not to patch: it is
his host and his repository.

- **`JWT_SECRET` and `MICONNECT_CLIENT_SECRET` are real random values.** Checked by fingerprint. No
  placeholder is in play for either.
- **`JWT_OLD_SECRET` is non-empty outside any rotation**, and the running build keeps accepting it
  until the value is emptied **and** `cercleapp.service` is restarted. A second valid signing key
  that nothing is rotating towards is a standing risk with no upside.
- **`AUTH_SECRET` is still the `.env.example` placeholder.** It is dead config - nothing reads it -
  but a placeholder sitting in a live `.env` is indistinguishable from one that matters.
- **`secure: false` on the session cookie is deliberate** while the host is HTTP-only. Do not "fix"
  it; it breaks sign-in. Same for the session row storing the **whole** `X-Forwarded-For`.

There is also one gap in the ledger that is his call, not ours: `undo` and `cashout` are declared in
the schema and written by nothing, so a mis-keyed consumption **cannot be corrected**. He declined
an `adjustment` kind on 2026-07-28, and `bun run db:check` refuses to guess the sign of either.

## The real addresses

| What | Value |
| --- | --- |
| Canari | `https://canari-emse.fr` |
| Canari cotisant endpoint | `GET https://canari-emse.fr/api/public/cotisant-status?assoSlug=cercle&sub=<userId>` |
| Cercle webhook endpoint | `POST https://cercle.canari-emse.fr/api/canari/topup` |
| OIDC issuer | `https://auth.canari-emse.fr/application/o` |
| OIDC JWKS | `https://auth.canari-emse.fr/application/o/cercle/jwks/` |
| Canari host | `ssh canari`, compose project `infrastructure-*`, Postgres db `auth_db` |
| Cercle host | `ssh cercle` (10.0.0.6, ProxyJump canari, key installed) |

On the Cercle host: `cercleapp.service` serves **`/var/www/le-cercle`**, not the git checkout in
`/home/cercle/le-cercle`. Its SQLite file is `/var/www/le-cercle/data/le_cercle.db`. There is no
`node` and no `sqlite3` on that box - drive it with `bun` (`/usr/local/bin/bun`), and note that
`journalctl -u cercleapp` shows nothing to the `cercle` account (not in the `adm` group), so probe
the endpoint rather than expecting to read its logs.

## Secrets, and which name they wear on each side

The same secret has a different variable name on each end. Getting this backwards is the single
most likely setup mistake.

| Secret | On Canari | On Le Cercle | Generate |
| --- | --- | --- | --- |
| Cotisant-status API key | GitHub secret `CERCLE_API_KEY` (the CD writes it into `infrastructure/.env`) | `CANARI_API_KEY` in `.env` | `openssl rand -hex 32` |
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

The key is a **GitHub secret**, not a hand-edited file. The CD regenerates `infrastructure/.env`
from the repo secrets on every deploy, so editing it over SSH works until the next deploy silently
reverts it - and the symptom then is the bar losing cotisant status for no visible reason.

```sh
gh secret set CERCLE_API_KEY --repo emse-students/canari   # value: openssl rand -hex 32
```

Then run a deploy (or re-run the last CD) so the key reaches `infrastructure/.env`. The sync step
warns when the secret is missing, so a deploy log carrying
`CERCLE_API_KEY is not set` means the endpoint is still rejecting everything.

Verify without printing the value:

```sh
ssh canari 'grep -cE "^CERCLE_API_KEY=.+" /home/canari/canari/infrastructure/.env'   # 1 = populated
```

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
- `CANARI_ASSO_SLUG` on the Cercle side must equal the association's slug in Canari. **It is
  `cercle`, not `le-cercle`** - the association's display name and its slug differ, and an
  unknown slug answers 404, which the Cercle treats as "not a cotisant" and bounces everyone.

Check the tier setup from the outside before going further (the key is in
`/home/canari/canari/infrastructure/.env` on the Canari host, so run this from there):

```sh
curl -s -H "X-Api-Key: $CERCLE_API_KEY" \
  "https://canari-emse.fr/api/public/cotisant-status?assoSlug=cercle&sub=<a-real-cotisant-userId>"
```

`tier` must be a **named** key. A `null` tier on a real cotisant means the base tier was never
converted, and every one of them will be treated as sans-alcool.

**Measured 2026-08-03, all seven as expected:**

| Call | Answer |
| --- | --- |
| `avec-alcool` cotisant | `200 {"isCotisant":true,"tier":"avec-alcool","expiresAt":null}` |
| `sans-alcool` cotisant | `200 {"isCotisant":true,"tier":"sans-alcool","expiresAt":null}` |
| unknown `sub` | `200 {"isCotisant":false,"tier":null,"expiresAt":null}` - **not** a 404 |
| forged key | `403` |
| empty key | `403` |
| unknown `assoSlug` | `404 Association not found` |
| `assoSlug=le-cercle` | `404` - proof the slug is `cercle` |

`expiresAt: null` is correct here and not a missing value: the association is in `lifetime` mode.

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
JWT_SECRET=<openssl rand -base64 48>
JWT_OLD_SECRET=            # only non-empty during a rotation
MICONNECT_ISSUER=https://auth.canari-emse.fr/application/o
MICONNECT_JWKS=https://auth.canari-emse.fr/application/o/cercle/jwks/
MICONNECT_CLIENT_ID=<from Authentik>
MICONNECT_CLIENT_SECRET=<from Authentik>
CANARI_BASE_URL=https://canari-emse.fr
CANARI_ASSO_SLUG=cercle
CANARI_API_KEY=<same value as CERCLE_API_KEY on Canari>
CANARI_WEBHOOK_SECRET=<same value as the product's webhookSecret>
```

`CANARI_INTEGRATION_ENABLED` is still present in the deployed `.env` but is referenced **nowhere in
the code** since the Cercle rewrite - the integration is unconditionally on. Do not rely on it as a
kill switch; to actually cut the link, empty `CANARI_API_KEY` (the Cercle then falls back to each
user's stored membership) or `CERCLE_API_KEY` on the Canari side (which refuses everyone).

`JWT_SECRET` was called `SESSION_SECRET` before the merge. Rotating it is the only way to revoke
every Cercle session at once; `JWT_OLD_SECRET` carries the previous value during a rotation and MUST
stay empty otherwise - an unset secret used as a verification key would accept anything.

Then, on the Cercle host: `bun run db:migrate` (idempotent, replays against `PRAGMA user_version`),
and back up `DB_PATH` before the first real service - the ledger is the only record of who owes
what.

## Verification, in order

Each step depends on the one before it. Stop at the first failure; a later step passing on top of a
broken earlier one proves nothing.

### V1 - OIDC round trip and identity

Log in as a real cotisant through MiConnect. Expect: redirected in, no `/unauthorized`.

Then, on the Cercle host, confirm the identity is the shared one. The snapshot columns this step
used to read (`is_cotisant`, `tier`, `cotisation_synced_at`) **no longer exist**: the rewrite stores
the tier as a foreign key to a `memberships` table instead.

```sh
bun -e 'import{Database}from"bun:sqlite";
const d=new Database("/var/www/le-cercle/data/le_cercle.db",{readonly:true});
console.log(d.query("SELECT u.uuid, u.first_name, u.role, m.name AS tier FROM users u LEFT JOIN memberships m ON m.id = u.id_membership ORDER BY u.rowid DESC LIMIT 3").all())'
```

`uuid` must be the same string as the user's Canari `userId`. If it is not, nothing downstream can
work: the Cercle asks Canari about `sub`, and Canari looks that up as its own primary key.

**Partially confirmed 2026-08-03**: two real accounts carry Canari-shaped 64-hex ids (the other 20
rows are UUID seed data), and the `avec-alcool` tag on Canari matches `id_membership = 1` ("Avec
alcool") on the Cercle. What is still owed is that a *fresh* MiConnect login produces that id -
those two rows could predate the current callback. Only a browser can close this.

### V2 - The access gate

- A real cotisant: gets in.
- A member of neither kind (no cotisation, not cercleux): bounced to `/unauthorized`.
- A cercleux with no cotisation: gets in, but any attempt to consume is refused with "not a
  cotisant". Site access and the right to consume are two different rights, by design.

### V3 - The refresh cadence, and the throttle ceiling

There is no snapshot TTL any more. The rewrite re-queries Canari (`syncCanaryMembership`) in exactly
two places: the login callback, and the session-JWT refresh - and that JWT lives **5 minutes**. So
the JWT lifetime IS the TTL, and an active user costs about one request per 5 minutes.

Load three or four Cercle pages in a row as the same user, then read Canari's logs:

```sh
ssh canari
docker compose -f infrastructure/docker-compose.prod.yml logs --tail=200 social-service | grep 'cotisant-status'
```

Expect **one** `[CERCLE] cotisant-status` line for the burst, not one per page.

Do the arithmetic before the first big perm: the throttle is 20 req/min counted per source IP and
the Cercle is one IP, so the ceiling sits near **100 concurrent users**. Past it Canari answers 429,
which the Cercle handles like any fetch failure - it falls back to the stored membership, so the bar
degrades to slightly stale tiers instead of locking up. The exception is a user logging in for the
FIRST time during saturation: they have nothing stored, and will be treated as a non-cotisant.

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

Buy the `balance_topup` product from Canari with a real (small) Stripe payment - **or** press the
test button on that product at `/admin/cercle`, which credits 5 EUR to the pressing admin's own
Cercle account through the exact same server path with no card charged. The test is worth running
first: it needs neither a Stripe Connect onboarding on Le Cercle nor a real payment, and everything
below applies to it unchanged, the delivery being produced by the same dispatcher. Its payment
intent is prefixed `pi_canari_test_` instead of `pi_3…`, and it does leave a real 5 EUR line in the
association's accounting - delete it by that prefix once the check is done.

On Canari:

```sh
docker compose -f infrastructure/docker-compose.prod.yml logs --tail=100 social-service | grep CERCLE
```

Expect `[CERCLE] webhook delivered: product=... attempt=1`. If all three attempts fail (delays 1s,
5s, 15s), the delivery is recorded in `webhook_deliveries` with its error and can be retried from
`/admin/cercle` once the cause is fixed - the payment is not lost.

On the Cercle: the balance must have moved by exactly `amountCents`, with one `ledger` row
(`type='topup'`, `uuid_staff` NULL - no human behind a Canari credit) and one
`canari_ledger_details` row carrying the payment intent. The table is `ledger`, not
`account_movements`; that name belonged to the pre-rewrite schema.

Then prove the idempotency, because Canari retries. Do **not** bother reproducing the exact original
bytes - re-sign a fresh body reusing the same `paymentIntentId`, which is a stronger check: it
proves the dedup keys on the intent rather than on byte-identity.

**Measured 2026-08-03** (balance 1500, 3 entries, before and after every line):

| Probe | Answer | Ledger |
| --- | --- | --- |
| replay, same intent | `200 {"ok":true,"duplicate":true}` | unchanged |
| replay, same intent, `amountCents` inflated to 999999 | `200 ... duplicate:true` | unchanged |
| forged signature | `401` | unchanged |
| `amountCents: -500` | `400 Invalid amount` | unchanged |
| timestamp 24 h in the future | `422 Invalid timestamp` | unchanged |

Idempotency is enforced by `canari_ledger_details.payment_intent_id` being `NOT NULL UNIQUE` inside
a transaction, not by an application-level check - the credit is written optimistically and rolled
back on conflict, so the database refuses a double credit even if the route's logic is bypassed.

**Known bug on the Cercle side, reported, not blocking:** on a duplicate the response reports
`balance` as *what the balance would have been*, computed inside the transaction that was then
rolled back - the replay above returned `balance: 2000` and, with the inflated amount,
`balance: 1001499`, while the stored balance never left 1500. The database is right and the credit
is safe; only the reported number is fiction. Canari checks the status code and ignores the body,
so nothing downstream is wrong today - but do not build anything on that field.
*Fix written 2026-08-03 on the Cercle branch `fix/audit-2026-08-canari-and-session`, awaiting Aurel.*

### V6 - Ledger integrity

At the end of the session, on the Cercle host, walk each account's entries in order: a `topup` adds
`amount_cents`, a `purchase` subtracts it (amounts are stored unsigned, the sign is in `type`), and
every row carries the `balance_after` it produced. Two things must hold - the chain must agree with
itself, and `users.balance` must equal the last `balance_after`.

```sh
bun -e 'import{Database}from"bun:sqlite";
const d=new Database("/var/www/le-cercle/data/le_cercle.db",{readonly:true});
for(const u of d.query("SELECT uuid,first_name,balance FROM users").all()){
 const l=d.query("SELECT type,amount_cents,balance_after FROM ledger WHERE uuid_user=? ORDER BY id").all(u.uuid);
 if(!l.length)continue; let r=0,ok=true;
 for(const e of l){r+=e.type==="topup"?e.amount_cents:-e.amount_cents; if(e.balance_after!==r)ok=false;}
 if(!ok||u.balance!==l.at(-1).balance_after)console.log("BAD",u.first_name,u.balance,r);}'
```

**Measured 2026-08-03: the only account whose whole history came through the real code path (3
Canari top-ups) is exactly consistent.** Seven others report BAD, and every one is fixture data: the
seed gave them an opening `users.balance` without a matching `topup` entry, so their running sum
starts below zero and can never reconcile. One more (`Aurel DAUTRY`) has a balance edited by hand
away from its last `balance_after`.

That matters more than it looks: **this check cannot be used as an alarm while it is permanently
red.** Either give the seed rows an opening `topup` entry or exclude them explicitly - a monitor
nobody can act on is a monitor nobody reads.

*Fix written 2026-08-03 on the Cercle branch `fix/audit-2026-08-canari-and-session`, awaiting Aurel:
migration `07` writes one opening entry per unexplained balance (it never touches `users.balance`),
and `bun run db:check` is the walk above, packaged. Once merged and migrated, this section becomes
`ssh cercle` + `bun run db:check` and the red is actionable.*

Note the ledger has no reversal movement, so **a drink charged to the wrong account cannot be
undone today**. Say so to the bar staff before the first real perm.

## If something fails

| Symptom | Look at |
| --- | --- |
| Everyone bounced to `/unauthorized` | `CANARI_API_KEY` vs `CERCLE_API_KEY`; `CANARI_ASSO_SLUG` must be `cercle`; Canari logs for `403` on `cotisant-status` |
| Every cotisant treated as sans-alcool | the base tier was never converted - `tier` comes back `null` and fails closed |
| `429` from Canari under load | past ~100 concurrent users - see V3, it degrades to stale tiers rather than failing |
| Webhook `404`, body is HTML | the route is not deployed on the Cercle - a missing SvelteKit route answers a 404 *page*, which looks like any other failure from Canari |
| Webhook `401` | the receiver is not stripping the `sha256=` prefix (check this BEFORE comparing secrets - it fails identically), or a proxy re-serialized the body |
| Secrets suspected of differing | compare fingerprints, never values: `md5` of the product's `webhookSecret` on Canari against `md5` of `CANARI_WEBHOOK_SECRET` on the Cercle |
| Balance credited twice | `canari_ledger_details.payment_intent_id` lost its `UNIQUE` constraint - that column is the whole idempotency mechanism |
| Reported balance looks absurd after a retry | known Cercle bug on the duplicate path, see V5 - the stored balance is fine |
