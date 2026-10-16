# Payments module

**Routes**: `src/routes/shop/`
**Components**: `src/lib/components/shop/`

## Responsibilities

- Boutique: browse and purchase association products.
- Online checkout (Lydia, shown as "Paiement Canari") for products and paid forms; cash for forms that allow it.
- Purchase history.

**Stripe left the product on 2026-10-07**: what it did, what was removed and the names kept for
rollback are in [stripe-archive](../../stripe-archive.md). Saved cards left with it - Lydia has no
saved methods, so every purchase is its own interactive request.

## Which payment provider is live

A `PaymentProvider` interface (`apps/core-service/src/payment/payment-provider.interface.ts`) sits
between `PaymentService` and the processor. The ids are `'lydia' | 'disabled'`; the implementations
are `lydia-payment-provider.ts` and `disabled-payment-provider.ts`.

Which one is active is a **platform admin setting read from Postgres per call**, not an environment
variable and not a startup decision - flipping it in `/admin/platform` takes effect with no deploy and
no restart. **The default is `disabled`** (migration `011_platform_config_drop_stripe.sql` moved a
stored `stripe` there). The frontend asks **`GET /api/payments/provider`** which is live and renders
the matching onboarding: Lydia needs the club's legal profile collected by Canari and posted to
`business/create`.

Lydia has no live status-poll endpoint, no customer object and no saved methods: the flows that do
not map onto it were removed rather than faked. The provider mapping and the credentials are in
[`plans/stripe-to-lydia-migration.md`](../../../../plans/stripe-to-lydia-migration.md) (archived).

## Where a provider's name may appear, and where it may not

**A provider's name is true in exactly one layer.** The message catalogue says "prestataire de
paiement" / "payment provider"; the neutral contract (`ConnectAccountStatusResponse`) lives in the
interface; log tags on shared paths are `[Payments]`. The names deliberately kept (the unmapped columns,
the `stripe` deep-link host) are listed with
their reasons in [stripe-archive](../../stripe-archive.md#the-names-that-outlived-the-processor---what-2026-10-09-renamed-and-what-stays).
`PayoutFeeHint.svelte` shows the Lydia fee (0,10 EUR + 1 %, `lydiaFees.ts`) only once
`GET /api/payments/provider` has answered `lydia`.

## Product purchase flow

```
/shop or /associations/:id (boutique tab)
  -> GET /api/associations/:id/products
  -> User clicks "Buy"
  -> POST /api/associations/:id/products/:productId/checkout
     -> core-service creates a Lydia payment request
  -> Redirect to the Lydia page
  -> Confirmed by lydia-request-callback (core-service), verified with the association's
     Business key - no return path exists for a product (see "What confirms a payment")
```

## Components

| Component | Role |
|---|---|
| `shop/ProductCard.svelte` | Product listing card |
| `shop/ProductPurchaseButton.svelte` | Buy button with loading state and success toast |

## Routes

| Route | Description |
|---|---|
| `/shop` | Global boutique (all associations' products) |
| `/shop/[productId]` | Product detail |

## Key API endpoints (core-service)

| Endpoint | Description |
|---|---|
| `POST /api/payments/create-checkout-session` | Checkout for forms |
| `POST /api/associations/:id/products/:productId/checkout` | Checkout for products |
| `POST /api/payments/lydia-request-callback` | Lydia's own confirmation |
| `POST /api/payments/request-state` | Internal secret only. A request's state at Lydia, by its `request_uuid` and the Business's vendor token |
| `POST /api/forms/submissions/:id/confirm-payment` (social-service) | Submitter or manager. Reads the row's OWN request at Lydia and records it if paid |

**A form payment is confirmed by Lydia's answer about the row's OWN request, read on either of two
triggers: the callback, verified with the association's Business key, and the payer's return**
([what confirms a payment](#what-confirms-a-payment-2026-10-16)). The callback fires whether or not
the buyer's browser returns; the return page polls `confirm-payment`. Both read the request the row
stored and record it only if Lydia answers paid. `verify-session` and `cancel-session` were meant to be that return
path and never worked - they took the submission from an `order_ref` `request/state` does not echo
([below](#what-requeststate-answers-and-what-it-does-not-2026-10-15)) - and were deleted on
2026-10-15. Repair a payment the callback missed through `confirm-payment`, never by an
`UPDATE`: `markPaid` in social-service writes the submission status, the cotisation tier
(`user_tags`, when the form sets `grantsCotisation`) and the `purchase_records` row, and a hand-written
update produces only the first. The 2026-08 Stripe webhook that never verified under bun is told in
[stripe-archive](../../stripe-archive.md#what-it-did).

## Payment delegation (parent-association routing)

An association that has no payment account of its own (or simply wants a parent to collect
on its behalf) can **delegate** its online payments to a **parent association**. When approved,
**all** of the child's online payments - shop products, paid forms, paid posts - are charged onto
the parent's payment account instead. The child keeps its own "association" identity in the
UI (never renamed to "club"); only the money destination changes.

### Model

Two dedicated fields on the association entity, kept distinct from the lists-only
`parentAssociationId` (which is about org ownership, not money):

| Field | Meaning |
|---|---|
| `paymentParentAssociationId` | The parent that receives this association's payments (`null` = none) |
| `paymentDelegationStatus` | `pending` (awaiting parent approval), `approved` (routing live), or `null` |

Constraints (enforced server-side in `associations.service.ts`):

- **Parent must approve.** A request lands as `pending`; the parent approves/rejects it.
- **Explicit + always to parent.** Once `approved`, every payment routes to the parent even if the
  child also has its own payment account.
- **One level only.** A parent that itself delegates cannot be chosen as a parent (no chains), and
  an association that already receives delegated payments cannot delegate its own.
- **Fails closed.** If a delegating child's parent can't be loaded, or the parent has not finished
  payment onboarding, payments are treated as *not ready* rather than falling back to the child.

### Routing decision point

`resolvePaymentTarget(asso, parent)` in
`apps/social-service/src/associations/payment-delegation.util.ts` is the **single** pure function
that decides where a payment goes. Every payment path in social-service
(`products.service` checkout/charge/`isActive`, `forms.service`, `posts.controller` paid posts)
resolves its payment account through it, so routing stays consistent. core-service just executes the
charge against whatever `connectAccountId` it is handed (a historic wire name now holding the Lydia account).

The purchase record still carries the **child's** `associationId`, so the Canari DB remains the
accounting source of truth even though the money lands in the parent's account.

### Parent accounting access

Approving a child grants the parent read access to that child's accounting (purchase records + paid
form payments), including an `.xlsx` export. These are **parent-scoped** endpoints: the route id is
the parent (so the existing `MANAGE_PRODUCTS` guard proves parent-admin), then the service verifies
the approved link via `assertIsApprovedParentOf`. The parent does **not** get the child's payment
dashboard or balance.

### UI

`/associations/[slug]/edit` -> **Delegation** tab (`edit/EditDelegationTab.svelte`, gated on
`MANAGE_PRODUCTS`). One component, two sections:

- **Club-side** - pick a parent association, request delegation, and see status (`pending` /
  `approved`, with a warning if the parent isn't payment-ready) or cancel.
- **Parent-side** - incoming request queue: approve/reject pending requests, revoke approved ones,
  and expand an approved child to view its accounting table + export button (reuses the "Achats"
  purchase-row layout).

### Endpoints (social-service, all `MANAGE_PRODUCTS`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/associations/:id/payment-delegation` | This association's delegation state |
| POST | `/api/associations/:id/payment-delegation` | Request delegation to `{ parentAssociationId }` |
| DELETE | `/api/associations/:id/payment-delegation` | Cancel own delegation (pending or approved) |
| GET | `/api/associations/:id/payment-delegation/children` | Parent's request queue (pending + approved) |
| POST | `/api/associations/:id/payment-delegation/children/:childId/approve` | Approve a child (parent must be payment-ready) |
| POST | `/api/associations/:id/payment-delegation/children/:childId/reject` | Reject/revoke a child |
| GET | `/api/associations/:id/payment-delegation/children/:childId/purchases` | Read a delegated child's purchases |
| GET | `/api/associations/:id/payment-delegation/children/:childId/purchases/export` | Child's purchases as `.xlsx` |
| GET | `/api/associations/:id/purchases/export` | Own purchases as `.xlsx` |

## See also

- [associations.md](associations.md) - association model, permission flags, admin panel tabs.
- [../../cotisations.md](../../cotisations.md) - membership dues (also routed through the online payment).
- [admin.md](admin.md) - platform admin surfaces (Cercle top-ups).

## The payer types an e-mail, and Lydia bounds the amount (2026-10-05)

Lydia's `request/do` sends the payment request to a **recipient**, and Canari stores no e-mail
address (the OIDC sign-in carries none). So the payer types one at payment: `PayerEmailPrompt` opens
from the boutique button and the form page ONLY when `GET /api/payments/provider` says `lydia`, the
address travels as `payerEmail` (social-service -> `POST /api/payments/create-checkout-session`),
core-service turns it into the provider's `payerRecipient`, and nothing keeps it. A malformed one is
refused before any provider call. The recipient is NOT an invoice address: Canari issues no invoices.

**The prompt and `PaymentModal` are portalled to `body` and sit on `--z-modal` (2026-10-07).** Both
were written in place at a raw `z-50`. The form page renders them inside `.page-scroll-wrap`, whose
`will-change: transform` makes it the containing block and a stacking context
([the layer ladder](../../../../frontend/src/app.css)): the "fixed" overlay was laid out against the
wrapper, so it started under the banner and scrolled away with the form (measured on dev's CSS at
390 px: overlay top `84`, then `-316` after a 400 px scroll), and the form's sticky submit bar, also
`z-50` and written later in the tree, painted over the hint, the field and its own "save a card"
link. `layerLadder.test.ts` now treats `data-keyboard-aware-overlay` as what it is - a window-covering
layer - and fails one that is not portalled or carries no named rung.

Lydia confirmed on 2026-10-04 that a request must be between **0,50 EUR and 1000 EUR**;
`LydiaPaymentProvider.createCheckoutSession` refuses anything outside it with a message instead of
letting Lydia answer. In homologation the payer page offers a card form and, at its end, buttons to
choose the final status - a real card is refused at the 3-D Secure step, so never type one there.

## Where Lydia sends the payer back (2026-10-05)

Stripe used to replace `{CHECKOUT_SESSION_ID}` in a return URL; **Lydia does not**, so a
paid form's page received the literal braces, `verify-session` refused it and the screen said
"payment not found" while the signed callback had in fact marked the submission paid. For Lydia,
`forms.service.ts` now swaps that placeholder for `submission_id=<id>` (the id exists before the
request does), the success page asks the submission and keeps asking while it is `pending` (the
callback may land after the redirect; `paymentReturnVerdict` is the one rule, at most 10 reads 3 s
apart, then an honest "awaiting confirmation" instead of an error), and the cancel page cancels that
pending submission. Since 2026-10-15 each of those reads is `confirm-payment`, which also asks
Lydia about the row's own request, so a payment whose callback was lost is confirmed while the payer
looks; the cancel page shows a paid answer as paid and a still-open request as such
([forms](forms.md#an-online-payment-holds-its-seat-for-30-minutes-and-a-late-one-is-decided-from-the-row-2026-10-15)).
The boutique needs none of this: its return URLs carry no session id and its fulfilment is the
callback.

**Not verified, and owed to Lydia or a phone**: whether Lydia appends parameters to
`browser_success_url`, whether it accepts the `fr.emse.canari://` deep link the phone app sends,
and the mobile deep-link branch itself (`hooks.client.ts` reads `submission_id` now). A return URL
you see in a test is the one the request was created with: a link made by hand with `/ok` and
`/ko` returns there, which is how a test once ended on `/ko`.

## What `request/state` answers, and what it does not (2026-10-15)

Measured from inside `canari-dev-core-service-1` with the dev estate's HOMOLOGATION provider token
and the "Les Rootz" homologation Business, against `homologation.lydia-app.com` only (tokens and
signatures redacted). One request, `request_id 12115506`, created with `order_ref` set and
`expire_time 3600`, then read four ways while open:

| `request/state` called with | Answer |
|---|---|
| `request_uuid` only (what `retrieveSession` sent) | `{state: "0", used_ease_of_payment: "unknown"}` |
| `request_uuid` + `provider_token` | the same |
| `request_uuid` + `vendor_token` | the same **plus `signature`** (32 characters) |
| `request_id` + `vendor_token` | the same as the line above |

- **The vendor token is not what lets the call through: it is what makes Lydia sign the answer.**
  The state is readable with the uuid alone.
- **No variant echoes `order_ref`**, although `request/do` echoed it back on creation. So the
  answer cannot say which submission it is about: the caller must already know, which is why
  `confirm-payment` reads by the uuid its own row stored, and why `verify-session` (which expected
  the `order_ref` there) could never name a submission and was deleted.
- **`request_uuid` is 32 hex digits, no dash** (`077f2efc...`). `payments/request-state` validated
  it as the dashed RFC 4122 shape and refused every real one until this was measured.

- **The answer carries no amount**, so `confirm-payment` trusts that the request it reads is the
  one the row stored at issue time (its own uuid, never the client's) and that its amount is the
  one `request/do` was sent. **Its `signature` is not verified**: the scheme is undocumented for
  this call, and the answer is read server to server over TLS from Lydia's own host, which is
  what makes it trustworthy here - not the signature.

**Not measured, and why: state 1 (paid) and state 5 (refused by the payer).** `1 = paid` is
**Lydia's documentation, NOT a measurement**, and `confirm-payment`, the settle of a retry and the
cancel all act on it. **A real sandbox payment, read back with `request/state`, is owed before
any STABLE ships this.** Both are reached
only by acting as the PAYER on Lydia's payer page (the homologation page's final-status buttons),
which is a human at the Lydia form, so they were not driven here. The code reads `1` as paid
from Lydia's documentation and reports `5`, like any code not measured, as `other`: a retry or a
cancel that meets it refuses with `PREVIOUS_PAYMENT_OPEN` until the hold ends, and `confirm-payment`
leaves the row as it is. Still owed, by a person on the homologation payer page, then one
`request/state` each: pay a request (expect `1`, and read whether the confirm callback arrives),
refuse one (expect `5`, and whether `request/cancel` then answers error 2), and what
`request/cancel` answers on the PAID one. Request `12115506` was left open on the sandbox; it
expires on its own (`expire_time 3600`).

## Which onboarding flag a screen reads (2026-10-03)

Stripe and Lydia kept independent account ids and `*OnboardingComplete` flags (migration 037; only Lydia is read now), so
"is this association ready" is a question about the ACTIVE provider. `isPaymentAccountReady(asso,
provider)` in `lib/associations/api.ts` is the one answer; the provider comes from
`activePaymentProvider.svelte.ts` (fetched once, `null` until known and on failure - which reads as
not ready and logs at error level, never as another provider). The edit page's boutique/forms warnings, the
paid-form recipient gate and the delegation tab all read it; before, they read the Stripe-era flag only
and a Lydia association whose flag was `true` in the database still showed as incomplete. The Lydia
card shows Pending until `lydiaOnboardingComplete` is true, then Active (nothing sets it
automatically yet - see the core-service page).

**Manual validation.** A GLOBAL ADMIN sees "Valider l'onboarding" on the Lydia card while the flag is
false (`POST /api/payments/complete-lydia-account/:associationId`, `NginxAuthGuard` +
`GlobalAdminGuard`, refused without a linked Lydia account). It calls social-service's existing
`lydia-complete`, which also releases withheld products. Not open to the club's own managers: they
would be declaring their own account ready. Removal of Lydia (`disconnect`) resets it.

## The platform can declare payments DISABLED (2026-10-05)

`platform_config.payment_provider` takes the value `disabled` (admin platform page, "Paiements
desactives"; `VARCHAR(16)` holds it, no migration). Core-service answers it with
`DisabledPaymentProvider`: `isConfigured()` is false, so every route gated on it gives its existing
"not configured" answer, and anything that reaches the provider anyway fails with a 400,
`Payments are disabled on this platform`. `GET /api/payments/provider` returns `{provider:'disabled'}`.

It is NOT a kill switch for money already moving: the Lydia request callback
verifies with its own secret, independent of the active provider, so a payment in flight still
completes. Social-service's `fetchActivePaymentProvider` returns the real value (it used to map
anything but `lydia` to `stripe`, and now rejects `stripe` as unknown), and `resolvePaymentTarget` resolves `disabled` to not ready with no
account id - a ready Lydia account, delegated or not, never routes. The client agrees:
`isPaymentAccountReady` is false, the association payments card shows the existing "no provider
configured" line instead of an onboarding flow, and `PayoutFeeHint` renders nothing.

## A provider-specific card waits for the provider (2026-10-07)

Found on dev `v1.1.2-alpha.1`: a direct load of `/associations/<slug>/edit?section=payments` drew the
old Stripe "Configurer les paiements" card on a Lydia platform, and its button got a 400 from
`/api/payments/onboarding`. The edit page held its OWN `activePaymentProvider` initialised to
`'stripe'` and fetched it only on a click of the tab, so a deep link (no click) never fetched it, and
a failed fetch fell back to `'stripe'` too. Both are the fallback `CLAUDE.md` forbids.

- The page now reads the shared store (`activePaymentProvider.svelte.ts`) like every other screen,
  and starts the load on mount. `current` is `null` until known; `failed` separates "loading" from
  "the fetch failed" (`activePaymentProvider.test.ts` pins the three states).
- Payments tab: `null` + not failed draws a loading line, `null` + failed draws a visible error with a
  retry button, and only a KNOWN provider draws its card (`lydia` or `disabled`).
- `onlinePaymentsReady` is false while the provider is unknown.

## Provider copy and refusals are one function each (2026-10-07)

`paymentProviderCopy.ts` (`onlinePaymentCopy`) words the form editor's single online line per KNOWN provider (Lydia =
"Paiement Canari", disabled = unavailable, no wallet or card-network copy); `paymentRefusal.ts` turns a typed `PAYMENT_PROVIDER_REFUSED`
into the one sentence both the shop toast and a paid form's inline error show. Details in
[forms](forms.md#four-defects-found-on-dev-v112-alpha2-2026-10-07).

## Expiry, merchant cancel and the callbacks, measured on the sandbox (2026-10-15)

Measured from inside `canari-dev-core-service-1` with the dev estate's HOMOLOGATION pair
(`DEV_LYDIA_*`, `LYDIA_ENV=homologation` pinned) against `https://homologation.lydia-app.com`, the
base URL hardcoded in the probe. Vendor: the dev homologation Business "Les Rootz" created that
morning. Every request: `0.50 EUR`, recipient `lydia-probe@example.com`, the same fields
`createCheckoutSession` sends, callbacks pointed at dev's `lydia-request-callback`. Tokens, the
vendor token and every `signature`/`sig` value are redacted below.

**`request/do` answers** `{error, request_id, request_uuid, message, mobile_url}`: the numeric
`request_id` (e.g. `12115496`) the callbacks carry IS in the response, beside the `request_uuid`
Canari stores today. `request/state` (`request_uuid` + `vendor_token`) answers
`{state, used_ease_of_payment, signature}` - no expiry date, no `request_id`.

**Expiry - the parameter is `expire_time`, an integer number of SECONDS from creation.**

| `expire_time` sent | Answer | Observed |
|---|---|---|
| absent | `error: "0"` | still `state 0` at the end of the session |
| `60` (created 16:38:50 UTC) | `error: "0"` | `state 6` at 16:40:34; `expire_url` POSTed at 16:40:09 (+79 s) |
| `120` (created 16:43:06) | `error: "0"` | `expire_url` POSTed at 16:46:07 (+181 s), then `state 6` |
| `0` | `error: "0"` | still `state 0` minutes later - `0` is NOT "expire now" |
| `3600`, `604800`, `2592000`, `31536000`, `1792000000` | `error: "0"` each | no upper bound refused; `1792000000` read as a Unix date would be YESTERDAY and the request stayed `state 0`, so the value is a duration, not a timestamp |
| `abc`, `-5`, `2026-10-16 12:00:00` | `error: "1"`, "Format de la date d'expiration incorrect" | the name is recognised and validated |

Expiry fires on what looks like a once-a-minute sweep at or after the deadline (both callbacks at
`:07`-`:09` past the minute), ONE `expire_url` POST each in the window watched, and leaves
`request/state` at **`6`** - the same code a merchant cancel leaves, so `state` alone cannot tell
expired from cancelled; the callback's `outcome` can.

**Merchant cancel - `POST /api/request/cancel.json` with `request_id` (the NUMERIC id) and
`vendor_token`, no signature.**

| Fields sent | Answer |
|---|---|
| `request_uuid` + `vendor_token` | `error: "1"`, "Parametre manquant" |
| `identifier` (numeric or uuid) + `vendor_token` | `error: "1"`, "Parametre manquant" |
| **`request_id` + `vendor_token`** | **`error: "0"`**, then `state 6`, and `cancel_url` POSTed (16:41:31) |
| `request_id` alone, or with `provider_token` instead | `error: "105"`, "Operation not allowed." |
| `request_id` of a request already cancelled, or already expired | `error: "2"`, "Cette transaction a deja ete traitee" |
| unknown `request_id` + `vendor_token` | `error: "105"`, "Operation not allowed." |

So cancelling needs the numeric `request_id`, which Canari does not store today (it keeps
`request_uuid` only), and the target Business's `vendor_token`.

**The callbacks reach dev and our controller REFUSES them before verifying anything.** All three
(`expire` x2, `cancel` x1) arrived from `91.194.60.148` and dev's nginx logged `400 78`. 78 bytes is
exactly `{"message":"Missing request_id or sig","error":"Bad Request","statusCode":400}`
(`webhook.controller.ts`, unlogged since `BadRequestException` is not logged); an `Invalid
signature` answer is 70 bytes and logs an error line, and none was logged. Replaying a forged
callback against dev settles the encoding: `request_id=1&sig=00` form-urlencoded -> `400 70`,
the same as JSON -> `400 70`, but as `multipart/form-data` -> `400 78`, Lydia's exact answer.
core-service parses JSON and urlencoded only, so Lydia most likely POSTs `multipart/form-data`
and `@Body()` is empty. **Consequence: the signature has never been checked, so whether Lydia signs
with the provider's or the Business's private token (the CSM says the Business's) is still unmeasured;
and no confirm/cancel/expire callback can fulfil anything on dev or prod until the body is parsed.**

**Still unknown.** The callback's exact field names and Content-Type (inferred from the 78-byte
answer, not read; nginx logs neither); the signing key; the DEFAULT lifetime when `expire_time` is
absent or `0` - request `12115504` (uuid `2c4c4bb4...`, no `expire_time`) and `12115498`
(`expire_time=0`) were left open on the sandbox, so a `request/state` on them later bounds it;
whether `expire_time` has a ceiling (one year and `1792000000` s were both accepted); whether
an expire/cancel callback is retried after a non-2xx.

### `request/state`, the payer's own cancel, and a callback that is PARSED (2026-10-15, 18:30Z)

Same sandbox, same rules. `request/do` echoes `order_ref` in its answer when one is sent.

| `request/state` fields sent | Answer |
|---|---|
| `request_uuid` alone (what `retrieveSession` sends) | `{state, used_ease_of_payment}` - works, unsigned |
| `request_uuid` + `provider_token` | same, unsigned |
| `request_uuid` + `vendor_token` | `{state, used_ease_of_payment, signature}` |
| `request_id` + `vendor_token`, or `order_ref` + `vendor_token` | same, signed - both lookups find the request |
| unknown `request_uuid`, or unknown `order_ref` | `error: "2"`, "Requete introuvable" |

**No variant ever returns `order_ref`**, so `retrieveSession`'s `metadata` from it is always empty;
`vendor_token` is optional and only adds a `signature`.

**The payer's "annuler la commande" link** (`/collect/cancel?uuid=...` on the payer page) redirects
to `browser_fail_url` and leaves `state 6` - the same code as a merchant cancel and an expiry, not
`5`. It POSTed `cancel_url` at 18:37:02Z, by then on a dev build carrying the multipart parser of the
section below: nginx logged `400 70` and core-service logged `signature verification failed
(outcome=cancel)`. **So the body now parses (`request_id` and `sig` are present) and the PROVIDER
private token does NOT verify Lydia's callback** - consistent with the CSM's "signed with the
Business's token", though a wrong field set in `verifyRequestCallback` would fail the same way; the
field names were not logged, since that log line fires only when fields are missing.

**Not produced, so unmeasured:** the state of a PAID request (`1` expected) and of a payer decline
(`5` expected), and what `request/cancel` answers on a paid request. A test card (`4111...`) is
refused before any status choice ("ne permet pas l'usage du code de securite 3DSecure",
`/collect/payment-error?code=4`) and the request stays `state 0`; no Lydia sandbox test card is
documented here, and none was guessed further.

## Lydia's callbacks reached `lydia-request-callback` with an EMPTY body (2026-10-15)

Two real calls from Lydia's servers (an `expire` at 16:40Z and a `cancel` at 16:41Z on dev, source
`91.194.60.148`) were answered `400` with the 78-byte `Missing request_id or sig`, and the route
logged nothing: the global parsers read JSON and urlencoded only, so a body of any other type arrives
with no field at all. **The route now reads `multipart/form-data` too** (`NoFilesInterceptor`, which
leaves every other body type alone), and a refusal for missing fields logs the content type and the
FIELD NAMES, never a value - at most 16 names of 32 characters from `[w.-]`, plus the count, because the
sender chooses every name and a newline in one would forge a log line. **The route is public, so
multer is bounded** (16 fields, 4096 bytes each, 16 parts, no file) and the signature comparison is
`timingSafeEqual`. **A callback that fails verification now logs, on the same line, the names it carried
and the names it was verified over** (`verified-over=[request_id,amount,currency,order_ref,vendor_token]`),
because 2026-10-15 measured that the Provider private token does not verify Lydia's callback and a wrong
field SET fails identically to a wrong KEY. **This is a hypothesis about Lydia's body type, not an observation of
it**: the test reproduces the exact symptom without the interceptor, but the next real callback's
log line is what settles it. (Settled on 2026-10-16: the Business's key, over every field but `sig` -
[what confirms a payment](#what-confirms-a-payment-2026-10-16). The `verified-over` list is gone with
the guessed field set.)

## What confirms a payment (2026-10-16)

**Measured on the sandbox, 2026-10-16:** Lydia's `request/do` callback is `multipart/form-data` with
seven fields - `currency`, `request_id`, `amount`, `signed`, `vendor_token`, `order_ref`, `sig` - and
`sig` is `signLydiaParams` (MD5 of the `key=value` pairs sorted by key, joined by `&`, then `&` and the
key) over EVERY received field but `sig`, `signed` included, with the **Business** private token of the
Business that issued the request. The Provider private token never verified one, so nothing reads
`LYDIA_PROVIDER_PRIVATE_TOKEN` any more (its secret and manifest row are a follow-up). The cancel and
expire callbacks were measured; a CONFIRM is not (no payment completes in the sandbox) and is assumed
to come from the same mechanism.

**The verification** (`lydia-callback-verification.ts`, core-service): the signed set is whatever
arrived minus `sig` - not a list the code chooses - and every value must be a string (16 fields, 512
characters each at most). The key is the one of the association whose `lydiaAccountId` is the body's
`vendor_token`, asked of social-service over `POST /api/internal/associations/lydia-callback-key`
(`X-Internal-Secret`, `Cache-Control: no-store`, under `/api/internal/`, which no nginx `location`
routes). Resolving the key FROM the body is sound because the signature is the proof: anyone may name
a public vendor token, nobody but the Business can sign for it. **Every failure is ONE 400 `Invalid
signature`** - unknown association, no key, wrong key, wrong field set, a non-string value - so the
route says nothing about which associations hold a key; the reason (`unsignable-body`,
`no-vendor-token`, `no-key`, `mismatch`) goes to the server log only. Failing to reach social-service is
a 503: not a verdict, and Lydia may retry it.

**A verified callback is a TRIGGER, never the payment.** For a form, core posts `{ vendorToken,
requestId }` to `internal/forms/submissions/:id/provider-confirm`; social-service first checks the row's
PAYEE account (its form's association, or that association's approved parent, whatever provider is
active) is that `vendorToken` - so an authentic callback of association A naming B's submission in its
`order_ref` settles nothing, logged at ERROR - then reads the row's OWN `request_uuid` at Lydia
(`request/state`, with the verified Business) and calls `markPaid` only if Lydia answers paid. That is
the very settle the payer's return makes (`settleFromProvider`); nothing of the callback's amount or
request id decides a status. A confirm naming a request the row no longer holds is logged at ERROR (a
payment nothing would record). The internal `mark-paid` route is gone. A cancel or expire callback
posts `{ requestId, vendorToken }` to `cancel-pending`, which applies only to the row's current
request AND only if `vendorToken` is its payee.

**KNOWN GAP - the boutique.** A product checkout stores no row naming its request, so there is nothing
of ours to read back: `purchase-completed` is refused unless `vendorToken` is the product's payee, and
the amount recorded is the verified callback's. Closing it needs a stored product checkout (a table),
not done here.

**Where the key comes from: the payout manager types it.** `PUT /api/associations/:id/lydia-business-key`
(`MANAGE_PAYOUT_ACCOUNT`, the permission of every other Lydia route) stores it ENCRYPTED in
`associations."lydiaBusinessKeyCiphertext"` (migration 086): AES-256-GCM (`common/secret-box.ts`)
under a key derived by HKDF from `LYDIA_KEY_ENCRYPTION_SECRET`, with `<associationId>:<vendorToken>` as
additional data, so a ciphertext copied to another row, or kept across a re-onboarding to another
Business, does not open. **Write-only:** `GET` on the same path answers `{ set }` and nothing else, the
PUT answers `{ set: true }`, the audit line names the association and the actor and never the value,
and the column is mapped `select`/`insert`/`update: false` so no entity read can carry it. Unlinking
the Business clears it. The copies of production strip it (`copy-strips.sh`) and a local estate
regenerates the secret (`env-from-prod.sh`), so a laptop with a dump cannot open one.

**Why not capture it at `business/create`.** `business/create` answers `api_token`, `api_token_id` and
`dashboard_url`; Lydia says each validated Business has a `private_token` in its console, "Mes
informations". That `api_token_id` IS that private token is a hypothesis nobody has measured (it needs a
validated Business's key to compare), and storing an unidentified secret is worse than storing none -
so `api_token_id` stays unpersisted and redacted from logs.

**No key yet: the designed state.** The Lydia panel shows "Non renseignee" and says callbacks cannot be
verified yet. Every callback of that association is refused (400); a FORM payment is still confirmed
when the payer comes back (`confirm-payment`), and a boutique purchase is not confirmed at all until a
key is set.
