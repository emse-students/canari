# The Lydia API as Canari knows it

The ONE reference for what Lydia's API does, as learned by this project. Lydia's own documentation is
partial and its sandbox moves, so every row below carries WHERE IT COMES FROM. **A row marked
`doc` or `csm` has not been seen to be true; only `measured` has.** Add a fact here when you learn
one, with its source and date - the narrative of how each was found stays in
[payments](frontend/modules/payments.md), which this page does not replace.

Sources: **measured** = observed by this project against the sandbox (`homologation.lydia-app.com`),
date given, or against **production** where the row says so (first run 2026-10-23); **doc** = Lydia's published API documentation, never observed; **csm** = written by
Lydia's customer-success contact in the 2026 exchange, never observed; **inferred** = our reading.

No token, signature or key value appears in this repository, on this page or anywhere: names only.

## 1. The four credentials, and what each is for

| Name | Public? | Scope | What it does |
|---|---|---|---|
| Provider token (public) | no | the whole platform, one pair | `provider_token` on `business/create`, `request/do` and `request/state` |
| Provider private token | no | the whole platform | signs calls that Lydia asks to be signed; **does NOT verify callbacks** (measured 2026-10-15) |
| `vendor_token` | yes | one Business (one association) | names the destination of a payment; `business/create` answers it as `api_token`; stored as `associations.lydiaAccountId` |
| Business private token | no | one Business | **signs that Business's callbacks** (measured 2026-10-16 on the sandbox, and a `confirm` in production 2026-10-23); shown in the Lydia console, "Mes informations", once the Business is validated (csm) |

- The Business private token is **not returned by an API call** (csm, 2026-10-20: it must be read from the
  console after the documents are validated). `business/create` answers `api_token`, `api_token_id` and
  `dashboard_url`; whether `api_token_id` IS the private token is **unmeasured** (it needs a validated
  Business whose console value can be compared). Canari does not capture it: a payout manager pastes the
  key, write-only, encrypted at rest ([payments](frontend/modules/payments.md), PR #1940).
- Lydia can regenerate a Business private token; the old one is invalid at once (csm, 2026-10-20). Nothing
  here regenerates it.
- Lydia asked that the `vendor_token_id` stay strictly private in the backend (csm).
- **Which environment a Provider token belongs to** (measured 2026-10-23): call `business/create` on each
  base URL with the `provider_token` and NO other field. Its own environment answers error 1, "Parametre
  manquant", and creates nothing; the other answers code 104, "Provider inconnu". `request/state` cannot
  tell: it does not check `provider_token` at all.
- **A Business created OUTSIDE the Provider is accepted under it** (measured in production 2026-10-23): an
  association's older Lydia Pro merchant account, created directly with Lydia, used as `vendor_token` with
  our production Provider token, issued a request, took a real payment and sent a `confirm` that verified
  with that Business's own private token. Its console ("Mes informations") shows its production public and
  private tokens; its TEST tokens are not in the console, only obtainable by e-mail to Lydia's support.
  Canari does not use this path: see [the enrolment rule](frontend/modules/payments.md#enrolment-goes-through-canari-and-only-through-it-2026-10-23).

## 2. Calls

Base URLs: sandbox `https://homologation.lydia-app.com`, production `https://lydia-app.com`; every call
is `POST /api/<call>.json`, form-urlencoded. Answers are JSON `{error: "0", ...}` on success; a rejected
`business/create` answers `{status: "error", code, message}` instead (measured).

### `request/do` - ask a payer for money

Fields Canari sends: `amount` (decimal string, two digits), `currency`, `type` (`email` or `phone`),
`recipient`, `message`, `vendor_token`, `provider_token`, `order_ref`, `confirm_url`, `cancel_url`,
`expire_url`, optionally `expire_time`, `browser_success_url`, `browser_fail_url`, `end_mobile_url`.
`request/do` takes **no signature** (doc: reserved to another Lydia product).

Answer (measured 2026-10-15): `{error, request_id, request_uuid, message, mobile_url, order_ref}` -
the numeric `request_id` (what callbacks carry) AND the `request_uuid` (**32 hex digits, no dashes**), plus
`order_ref` echoed. `mobile_url` is the payer page `.../collect/payment/<request_uuid>/auto`.

- **Amount range: 0.50 to 1000.00 EUR** (csm, 2026-10-04); Canari refuses outside it before calling.
- **`order_ref` must be UNIQUE per request**: a second `request/do` with an `order_ref` already used
  answers error 3, "order_ref deja utilise" (measured 2026-10-21). Canari's boutique reused one string per
  product and user, so a declined purchase could never be retried (tracked in [backlog](backlog.md)).
- **`expire_time` is an integer number of SECONDS from creation** (measured 2026-10-15): `60` expired after
  about 79 s, `120` after about 181 s (a sweep of roughly one minute); absent and `0` never expired in the
  window watched (`0` is NOT "expire now"); no ceiling refused (one year accepted); `abc`, `-5` or a date
  string answer error 1, "Format de la date d'expiration incorrect". The default lifetime is **unknown**; a
  sandbox request sent with no `expire_time` was still open (`state 0`) 47 minutes after its creation
  (measured 2026-10-23), so it is at least that.
- Error **5**, "Ce lieu d'activite est temporairement bloque", means the Business is not validated
  (measured again in production 2026-10-23, on a Business `business/create` had just made): nothing
  in the product probes it yet, and a global admin marks an association validated by hand
  (`complete-lydia-account`) once Lydia has validated the documents (24 to 48 hours, csm).

### `request/state` - read a request

Works with `request_uuid` alone (measured). `vendor_token` is optional and only adds a `signature` to the
answer; `request_id + vendor_token` and `order_ref + vendor_token` also find the request (measured
2026-10-15); an unknown id answers error 2, "Requete introuvable".
Answer: `{state, used_ease_of_payment[, signature]}` - **no amount, no expiry date, never `order_ref`**
(so the answer cannot say which Canari row it is about: the caller must already know).

**The `signature`** (doc, read 2026-10-27; **the composition is not measured**): MD5, built like every
Lydia signature (pairs sorted by key, `&`, then `&` and the key), over **`amount`** and **the id the call
named** (`request_id`, `request_uuid` or `order_ref`), with the **Business private token**. So
`md5("amount=<amount>&request_uuid=<uuid>&<key>")` for a read by uuid. Two consequences:

- The answer carries no amount, so the signature can only be recomputed over the amount the CALLER
  expects - which makes one comparison prove both the origin and the amount the request was issued for.
  Canari writes the amount exactly as `request/do` sent it (`"12.50"`, `lydiaAmountString`); whether
  Lydia signs that same string, or `"12.5"`, is the unmeasured part, and a wrong guess fails closed.
- **The `state` is not in the signed set.** The signature proves which request and which amount the
  answer is about, not what it says about them: the state still rests on the TLS read from Lydia's host.

Canari verifies it only where it asks to (`payments/request-state` with `expectedAmountCents`, used by the
reconciliation sweep, [section 7](#7-reconciliation---the-sweep-lydias-documentation-asks-for)); the payer's
return and the callback's read do not verify it yet.

| `state` | Meaning | Source |
|---|---|---|
| `0` | open, waiting for the payer | measured 2026-10-15 |
| `1` | **paid** | measured 2026-10-21 (an authorised payment on the sandbox page) |
| `5` | **declined** by the payer | measured 2026-10-21 |
| `6` | cancelled or expired - merchant cancel, payer's own cancel link and expiry all leave `6` | measured 2026-10-15 |

`state` alone cannot tell expired from cancelled; a callback's `outcome` (the query parameter Canari adds)
can. No other state has been seen; an unknown value must be treated as NOT paid and NOT settled.

### `request/cancel` - the merchant cancels

Fields: `request_id` (the NUMERIC id) + `vendor_token`, no signature. Answer `error: "0"`, then `state 6` and
the `cancel_url` callback fires (measured 2026-10-15 and 2026-10-21). Variants that fail (measured): sending
`request_uuid` or `identifier` -> error 1, "Parametre manquant"; `request_id` without `vendor_token` or with
`provider_token` instead -> error 105, "Operation not allowed."; a request already cancelled or expired ->
error 2, "Cette transaction a deja ete traitee". **A PAID request answers the same error 2 and stays `state 1`**
(measured on the sandbox 2026-10-23): a cancel never undoes a payment, and error 2 alone cannot say whether
the request was paid or closed - read the state after it, which is what Canari does.

### `business/create` - create an association's Business

Needs the legal profile of the association and the Provider token. Answers `api_token` (the
`vendor_token`), `api_token_id` (see section 1) and `dashboard_url`, **once**: the dashboard link is not
re-issuable (measured). An unknown `provider_token` answers `{status: "error", code: 104}`. Re-running the
onboarding replaces the linked Business silently: **refuse or confirm** is owed ([backlog](backlog.md)).

Fields Canari sends: `provider_token`, `name`, `address`, `zipcode`, `city`, `country`, `business_email`,
`business_phone`, each as typed in the onboarding form (`country` is the word typed, e.g. "France", not an
ISO code). **That these seven SUFFICE is measured** (three creations accepted in production 2026-10-23;
`provider_token` alone answers error 1). **That they are the WHOLE list is not**: it was taken from Lydia's
API documentation during the 2026-09 migration plan, which is not kept in this repository, and no optional
field was ever tried (the plan names an optional `webhook`). Which field, if any, names the Business's
HOLDER is the open question of the console sign-in below (asked to Lydia). In production (measured 2026-10-23) the answer also carries `merchant_ident`, EMPTY while
the Business is not validated, and `dashboard_url` is `.../console-pro/<business id>-<slug>`. That link
answers **404 to anyone not signed in to the Lydia console**, on the sandbox and in production alike: it is
not a sign-in link, and the console path is the one below.

### Activating a Business that `business/create` made (production, 2026-10-23)

Lydia e-mails the `business_email` a "Confirmation de votre compte Lydia Pro" right after the call. It
names three steps (quoted from that e-mail, not yet walked through end to end):

1. **Connexion flash**: open the Lydia console (`services.lydia-app.com/consolepro`) and scan the QR code it
   shows with the **Lydia Pro** mobile app.
2. **Documents**: upload the supporting documents in the console's "Documents justificatifs" tab (the
   e-mail's example is a KBIS or SIRET extract).
3. **Validation** by Lydia, after which the Business can take payments (error 5 until then).

**What blocked, measured:** the Lydia Pro app signs in with a PHONE NUMBER. Signed in with a number that
already held another Business, the console listed only that older Business, and nothing reached the new
one. A second Business, created the same day through Canari's onboarding with the e-mail and phone of the
person then signed in to the app, did not appear in that console either. So `business_phone` alone does not
attach a Business to a Lydia Pro identity (measured 2026-10-23), and how the holder of a Business made by
the Provider reaches its console is **unknown, asked to Lydia**. The e-mail's "Acceder a ma Console de
Gestion" button is the one entry point not yet followed from a signed-out browser.

### Refunds and listings - documented, never called

`transaction/cancel`, `transaction/refund`, `transaction/list` exist (doc). Refunding a transaction needs the
equivalent sum to have been sent to Lydia's company beforehand; each Business has an authorised overdraft
of 100 EUR which allows a few refunds if the tariff permits (csm, 2026-10-20). Whether `transaction/list`
aggregates is **unconfirmed**. No Canari code calls any of the three.

## 3. Callbacks (`confirm_url`, `cancel_url`, `expire_url`)

Lydia POSTs to the URL given on the request; Canari appends `?outcome=confirm|cancel|expire` so the route
knows which one it is (Lydia does not say).

- **Body: `multipart/form-data`** (measured 2026-10-15). A parser that reads only JSON and urlencoded sees
  an empty body.
- **Fields (measured 2026-10-16 and 2026-10-21)**: `cancel` and `expire` carry 7: `currency`, `request_id`,
  `amount`, `signed`, `vendor_token`, `order_ref`, `sig`. `confirm` carries 8: the same plus
  `transaction_identifier`. `signed` is a field of the callback, not a flag of ours.
- **Signature: the BUSINESS private token, over EVERY received field except `sig`, `MD5` of the
  `key=value` pairs sorted by key, joined by `&`, followed by `&` and the key** (measured 2026-10-16:
  `cancel` and `expire` verified this way on the sandbox; a `confirm`, with its `transaction_identifier`,
  verified the same way IN PRODUCTION on 2026-10-23, by Canari's own route with the key a manager had
  pasted). A field set that leaves `signed` out does not verify.
- A decline sends **no callback** at all (measured 2026-10-21); a payer's "annuler" link and a merchant
  cancel send `cancel`; expiry sends `expire` (a single POST in the window watched). Whether a non-2xx is
  retried is **unknown**.
- Which Lydia address calls is not recorded here; the route is public and rate-limited, and a verified
  callback is only a TRIGGER for a read of the row's own request ([payments](frontend/modules/payments.md)).

## 4. Where the payer goes back

- **`browser_success_url` / `browser_fail_url`** are used as sent. On success Lydia appends
  **`transaction=<32 hex, upper case>`** with `&` after our own query string (measured 2026-10-21), and
  leaves ours intact. It does NOT replace a `{CHECKOUT_SESSION_ID}`-style placeholder (measured 2026-10-05),
  so Canari puts its own `submission_id` in the URL.
- A **decline** ends on Lydia's own page `/collect/payment-error?code=28&uuid=...` with no link back and no
  redirect (measured 2026-10-21); an **expiry** shows the same page with `code=27`.
- A card refused at 3-D Secure ends on `payment-error?code=4` and the request stays `state 0` (measured
  2026-10-15, before Lydia's sandbox update).
- `end_mobile_url`: a deep link should be accepted (csm, 2026-10-20); **Canari has not tested one**.

## 5. The sandbox

- The payer page offers **Authorize, Decline and Expire** (measured 2026-10-21): choose the final status
  there, no test card needed since Lydia's update of 2026-10-21 (csm). The buttons that set a status by hand
  were removed for a while and re-published; they are not guaranteed to stay.
- A real card is refused at the 3-D Secure step in the sandbox; never type one.
- Requests created on the sandbox expire by themselves; an open one is harmless.
- The sandbox and production answer the same shapes as far as measured. Production was first run on
  2026-10-23: one real payment of the minimum amount, its `confirm` verified (sections 1 and 3).

## 6. Still unknown

- The exact `request/state` signature: whether the amount is signed as sent (`"12.50"`) or normalised
  (section 2). **Settled by the first reconciliation of a real request**: a `verified` line, or a
  `does NOT verify` ERROR on a row whose amount is right.

- The default lifetime of a request with no `expire_time` (at least 47 minutes on the sandbox).
- Whether `api_token_id` is the Business private token, and whether `business/create` ever returns the
  private token itself.
- How the holder of a Business made by `business/create` signs in to its console (section 2), and which
  documents Lydia asks of an ASSOCIATION (the e-mail names a KBIS or SIRET extract).
- What a refund does end to end.
- Whether a callback is retried after a non-2xx, and from which addresses Lydia calls.
- Whether `expire_time` has a ceiling.
- Whether Lydia accepts the app's deep link as `end_mobile_url` and appends anything to it.

## 7. Reconciliation - the sweep Lydia's documentation asks for

Lydia's documentation asks a merchant to reconcile through at least two of: the callback, `request/state`
and `transaction/list` - and, for every request whose callback has not arrived, to call `request/state`.
Canari had the callback and two `request/state` readers that both need a person (the payer's return, and
a retry). A payment whose `confirm` was lost and whose payer closed the tab was recorded by nothing. **The
sweep** (`LydiaReconciliationService`, social-service, since 2026-10-27) is the missing reader:

- **What it reads, and when.** A form answer still `pending` whose request has ENDED (`paymentRequestedAt`
  past `PENDING_HOLD_CUTOFF_SQL`, the hold = the request's `expire_time` + Lydia's measured expiry margin),
  and a boutique attempt still `open` past `expiresAt` + `CHECKOUT_EXPIRY_MARGIN_MS`. The threshold is the
  request's own lifetime, not a chosen clock: past it the request cannot change, so ONE read is final. The
  form half runs in the 5-minute expiry tick, **before** the expiry, because the hold ends when the request
  does: a row is due in the very tick that would expire it, and once `expired` nothing reads it again. The
  boutique half runs on its own 5-minute cron. At most 50 rows per kind per tick, newest first.
- **What it does with the answer.** Only a `verified` answer is acted on: `paid` through the ONE writer
  of each kind (`FormsService.markPaid`; `ProductsService.applyRequestState` -> `settlePaidCheckout`),
  `declined` and `cancelled-or-expired` through the release the payer's return uses. A `mismatch` is
  logged at ERROR and settles nothing; `unsigned`, an unknown verdict, an unreachable core or Lydia leave
  the row as it is. A Business with no stored key is not read at all: a form answer is then expired as
  before, a boutique attempt stays `open` (counted in the hourly line) for its buyer's next attempt or its
  callback. The one unsigned answer acted on is a boutique attempt read by its order_ref that Lydia does not
  hold (error 2): no request exists, no money moved, it is closed `cancelled` as the return closes it.
- **Why it cannot double-record.** Every write goes through a settle path that locks the row and moves it
  out of the status the sweep selects on; the sweep races the callback and the return on the same locks.
  Measured on a real PostgreSQL (`lydia-reconciliation.integration.spec.ts`): the sweep and seven returns
  settling one payment write ONE purchase record, for a form and for an attempt; with the attempt's row
  lock removed, the boutique case wrote more than one. Two replicas running one tick read twice and write
  once.
- **What it reports.** One line per row it reads, and once an hour
  `[RECONCILE] last hour - forms: examined= settled= released= unchanged= skipped-unverified= unavailable=
  errors=; boutique: ...; ended boutique attempts left open with no Business key: N`, even when all zero.

**Not covered, known:** a form answer the expiry moved to `expired` before any read (a backlog over 50 in
one tick, logged at ERROR; Lydia unreachable in that tick; no key) - its payment is still recorded by its
callback or its payer's return, which read `expired` rows. A form keeps no snapshot of the Business its
request went to, so a form whose association re-linked another Business meanwhile is read with the new one
and does not verify (ERROR). `transaction/list` is not used.

## See also

- [payments](frontend/modules/payments.md) - how Canari uses these calls, with the dated measurements.
- [forms](frontend/modules/forms.md) - a paid form's seat hold and the payer's return.
- [backlog](backlog.md) - the defects found on the way.
