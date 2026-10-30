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

**Which Lydia the credentials address is `LYDIA_ENV`, and each estate sets it differently (2026-10-23).**
`lydia-payment-provider.ts` trims and lowercases the value and uses `https://lydia-app.com` only when
it reads `production`; anything else (a typo included) is the homologation sandbox. Production renders
it from the GitHub secret `LYDIA_ENV` (manifest row `required`); **`render-env.sh` accepts only
`production` for the production estate (user, 2026-10-23)** and refuses a deploy without it or with
any other word, so pointing production at the sandbox takes a deliberate edit of `allowed_values()` in
a pull request, never a secret typed by hand. **When it is checked matters:** on a stable, `serve-prod`
runs only after BOTH stores took the version (`release.yml`: it `needs` `android` and `ios`), so a
missing or mistyped secret found by the render would surface AFTER the store submission. The release
`preflight` job therefore checks the secret is exactly `production` for a stable, before anything is
published (the value is never printed; the render stays the second guard). Until that row existed, production's `.env` kept
`infrastructure/.env.example`'s `homologation` - the compose default `${LYDIA_ENV:-production}` never
applies, because the template always sets the key. Dev skips the row and pins `LYDIA_ENV: homologation`
as a literal in `docker-compose.dev.yml`, with the sandbox pair in `DEV_LYDIA_*`
([dev-environment](../../infrastructure/dev-environment.md)). A LOCAL estate built from a production
dump gets `LYDIA_ENV=homologation` and EMPTY Provider tokens (`env-from-prod.sh`): production's pair
moves real money and must not sit on a laptop.

**What this does and does not decide.** The platform setting above (`payment_provider`) already read
`lydia` in production before this change, so it never kept production inert: the sandbox base URL did
(a request issued there moves no money). With `LYDIA_ENV=production` and the production pair, an
association whose Business is linked and validated takes real payments, and the setting STAYS `lydia`
(user, 2026-10-23).

**Rolling back to a release BEFORE this one is a trap.** An older `render-env.sh` and manifest do not
know `LYDIA_ENV`, and the older `verify-secrets` does not check it, so the rollback deploy re-renders the
template's `homologation` and the core addresses the sandbox with the production tokens, in silence.
After such a rollback: set `LYDIA_ENV=production` in the production `.env` and recreate the core-service
by hand (the container alone, through the compose file the deploy uses). The same recreate with
`LYDIA_ENV=homologation` is the way back to the sandbox, where the production pair then fails loudly
with Lydia's "Provider inconnu" (code 104) instead of moving money.

GitHub masks the word `production` in the logs of a run that reads this secret, because it is a
secret: expect `***` where the value would print; the render's error line names the key and the
accepted word, not the value.

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
     -> social-service settles the buyer's previous OPEN attempt, checks "already purchased",
        writes a product_checkouts row, then core-service creates the Lydia request
        (order_ref product:<productId>:<checkoutId>)
  -> Redirect to the Lydia page
  -> On return (success OR fail URL): /shop?checkout_id&association_id&productId
     -> POST .../products/:productId/checkouts/:checkoutId/confirm, polled while open
  -> And Lydia's confirm callback (core-service, verified with the Business key): a trigger on the
     attempt its order_ref names, read at Lydia the same way
```

The whole mechanism is [below](#a-product-checkout-is-a-row-one-per-attempt-2026-10-21).

## Components

| Component | Role |
|---|---|
| `shop/ProductCard.svelte`, `shop/MembershipCard.svelte`, `shop/ProductPrice.svelte` | A non-tier product card; ONE membership card with a row per tier still offered (`$lib/shop/productCards.ts`'s `offeredTiers`, a thin wrapper over the ONE pricing decision in `$lib/pricing/viewerPrice.ts`: the held tier and lower ones are not offered, the association's cotisations being disabled hides the whole card behind its reason, and the highest-tier holder gets no card at all). `ProductPrice.svelte` reads `viewerPrice.ts`'s `preferentialPriceLabel`/`fullPriceLabel` (the server's `viewerDueCents`, through `formatAmount` - Intl, never `toFixed`); a technical name such as `balance_topup` is replaced by a localized type label (`productDisplayName`). The paid return banner names a top-up or a membership by the product type; the confirm answer carries no amount and no delivery state, so a top-up says the credit follows |
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
| `POST /api/payments/request-state` | Internal secret only. A request's state at Lydia, by its `request_uuid` (or a boutique attempt's order_ref) and the Business's vendor token |
| `POST /api/forms/submissions/:id/confirm-payment` (social-service) | Submitter or manager. Reads the row's OWN request at Lydia and records it if paid |
| `POST /api/associations/:id/products/:productId/checkouts/:checkoutId/confirm` (social-service) | The buyer only. Reads the attempt's OWN request at Lydia and records it if paid |

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

- [../../lydia-api.md](../../lydia-api.md) - the Lydia API reference: credentials, calls, states, callbacks, what is measured and what is not.
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
A GUEST on a public form (no account, WP-P1) types it the same way, through the same prompt, and it
is the guest's only contact with the payment: it is forwarded once and stored nowhere (decision PP2).

**OWED MEASUREMENT (2026-10-22): whether Lydia writes to the recipient of a `request/do` on its
own, and which documented field turns that off.** `request/do` sends no notification field today,
so Lydia's default applies, and nothing here has measured that default. It matters most for a
public form's guest (`forms.md`), whose recipient is typed on a public page and verified by no
one. No field is added until it is measured: on homologation, once the dev Business is relinked
(owed by the user), send one request per candidate value to an inbox someone watches, and record
here what arrived. Until then, a guest's payment request may reach the typed address from Lydia.

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
`LydiaPaymentProvider.createCheckoutSession` refuses anything outside it instead of letting Lydia
answer. The refusal is TYPED: `code: AMOUNT_OUT_OF_RANGE` with `minCents` / `maxCents`, the same
shape a shop product's own free-amount bounds answer, and social-service refuses a form total outside
the range before calling core, with the same answer. The range lives in two constants that share no
package - `LYDIA_MIN/MAX_AMOUNT_CENTS` (core) and `PROVIDER_MIN/MAX_AMOUNT_CENTS` (social,
`core-payment-error.ts`) - and both apps' specs assert them against
`libs/contracts/payment-amount-range.json`, so they cannot drift. Every frontend refusal builder
reads the bounds through `amountBoundsOf` (`associations/api.ts`), and `providerRefusalMessage`
words them in the reader's locale (`formatAmount`), never echoing the server's English. A shop
product's free amount (`customAmountCents`) and a manager's cash grant go through ONE bounds check
(`assertWithinCustomBounds`, `products.service.ts`); the checkout body is typed inline and so never
validated by the pipe, which is why `wholeCentsOf` refuses anything but a non-negative safe integer
at the controller (`AMOUNT_INVALID`) - `5000.5` used to be charged rounded and recorded as sent. In homologation the payer page offers a card form and, at its end, buttons to
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
The boutique has the same shape since 2026-10-21: its return URLs carry the attempt
(`checkout_id`), and the shop page asks about it
([below](#a-product-checkout-is-a-row-one-per-attempt-2026-10-21)).

**A GUEST comes back elsewhere (WP-P2, 2026-10-22).** A guest on a public form has no session for
`/forms/success` to authorise, and a submission id is no proof. Its request is created with
`/f/:formId/receipt?receipt=<random>` as both return URLs, and that page confirms through
`POST /api/public/forms/receipts/confirm`, which finds the row by the receipt's SHA-256 and runs the
same `confirmPayment` - Lydia read about the row's own request, server to server. The verified
callback settles a guest row exactly as a member's ([forms](forms.md#the-guests-return-from-lydia-a-receipt-not-an-id-wp-p2---a-security-surface)).

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
  one `request/do` was sent. **Its `signature` is not verified on this path**: the answer is read
  server to server over TLS from Lydia's own host. (Since 2026-10-27 Lydia's documentation is read:
  the signature covers the amount and the id read, not the state, and the reconciliation sweep
  verifies it - [lydia-api](../../lydia-api.md#requeststate---read-a-request).)

**State 1 (paid) and state 5 (declined by the payer) were measured on dev, sandbox, on
2026-10-21**: `1` is a paid request, `5` a payer's decline, which sends NO callback and ends on
Lydia's own error page with no link back. `LYDIA_REQUEST_STATES` classifies 0 / 1 / 5 / 6 as `open`
/ `paid` / `declined` / `cancelled-or-expired`, and any other code as `unknown` (never paid, never
settled). A `declined` request is final: a retry settles it and issues a new one, and
`confirm-payment` releases the answer so the payer can retry
([forms](forms.md#a-declined-payment-releases-the-answer-2026-10-21)). Before that it read as an
unmeasured `other`, and a retry refused with `PREVIOUS_PAYMENT_OPEN` until the hold ended. A boutique attempt closes as `declined` on it, and its buyer can start a new one. On a PAID request `request/cancel` answers error 2 and the request stays paid (measured
2026-10-23); on a DECLINED one it is still not measured (the state read after an error 2 is what makes
either harmless). Request `12115506` was left open on the sandbox; it
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

**Not produced that day** (since measured, 2026-10-21: `1` paid, `5` declined, see above): the
state of a PAID request and of a payer decline. A test card (`4111...`) is
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
`no-vendor-token`, `no-key`, `mismatch`) goes to the server log only. Failing to READ the key (social
unreachable, or social without `LYDIA_KEY_ENCRYPTION_SECRET`, which throws rather than answering null)
and failing to APPLY a verified callback (fan-out error, the row's request unreadable at Lydia) are a
503: not a verdict about the callback, and the status Lydia may retry.

**A verified callback is a TRIGGER, never the payment.** For a form, core posts `{ vendorToken,
requestId }` to `internal/forms/submissions/:id/provider-confirm`; social-service first checks the row's
PAYEE account (its form's association, or that association's approved parent, whatever provider is
active) is that `vendorToken` - so an authentic callback of association A naming B's submission in its
`order_ref` settles nothing, logged at ERROR - then reads the row's OWN `request_uuid` at Lydia
(`request/state`, with the verified Business) and calls `markPaid` only if Lydia answers paid. That is
the very settle the payer's return makes (`settleFromProvider`); nothing of the callback's amount or
request id decides a status. A confirm naming a request the row no longer holds is logged at ERROR (a
payment nothing would record). The internal `mark-paid` route is gone. **A cancel or expire callback is
a trigger by the same rule (2026-10-18):** core posts `{ requestId, vendorToken }` to `cancel-pending`,
which acts only on the row's current request AND only if `vendorToken` is its payee, and then reads
that request at Lydia (`settleFromProvider` again): `cancelled-or-expired` (state 6) or `declined` (5) releases the seat, under the row
lock and only while the row still names the request read; `paid` records the payment instead; `open`,
an unmeasured state or a failed read keeps the seat (`unreadable` becomes core's retryable 503). So a
cancel signed with a key the payout manager typed cannot release a seat Lydia still holds open.

**The signature is not canonical, and nothing depends on it being so.** Lydia's scheme joins
`key=value` pairs with `&` and escapes neither, so `{a: '1&b=2'}` and `{a: '1', b: '2'}` sign the same
string: one signed body can be re-split into another with the same digest. That is Lydia's format, not
ours to change, and it costs nothing here because no outcome is decided from a callback's fields - every
one re-reads the row's own request at Lydia. The signed set is built with `Object.fromEntries`, so a
sender-chosen `__proto__` name stays a plain key (the protection of #1946).

**The public route is rate-limited at the edge:** nginx's `lydia_callback` zone, 5 r/s burst 50 per
client address on `POST`, answering 429 - far above the handful of callbacks Lydia sends per payment,
and a bound on what a flood of forged bodies (each one a key lookup) can cost.

**The boutique was REFUSED on the callback path until it stored its attempts (2026-10-16 to 2026-10-21).**
A product checkout stored no row naming its request, so there was nothing of ours to settle from - and a
verified signature proves only that the key the payout manager TYPED signed it. Settling from the
callback would have let that manager grant any tag, fire any Cercle webhook and record any purchase with
no money moved. So a verified `product:` confirm fulfilled nothing and was logged at ERROR for a human.
Since migration 101 it is a trigger on the stored ATTEMPT, by the same rule as a form: the attempt's own
request is read at Lydia, and the verified Business must be the one it was issued to
([below](#a-product-checkout-is-a-row-one-per-attempt-2026-10-21)).

**Production rollout (per the user, 2026-10-22, relayed by the lead session):** migrations 100 (the
per-association Lydia Business key) and 101 (product checkout attempts) MAY ride the next STABLE to
production; payments stay OFF in production (`platform_config.payment_provider` unchanged).
**Corrected 2026-10-23:** production's `payment_provider` already read `lydia` when that was written. What
kept production inert was NOT the flag: it was the sandbox Provider pair (a request issued to Lydia's
sandbox moves no money) and the absence of any onboarded Business or stored callback key. Read on
2026-10-23: one association linked, none validated, no key stored - so none was payment-ready.

**What changed with the production pair (2026-10-23, the user's direct order).** The production secrets
now hold Lydia's PRODUCTION Provider pair, and the production core-service was recreated with
`LYDIA_ENV=production`, so it talks to `lydia-app.com`: a request it issues now moves REAL money, and an
association whose Business is linked and validated takes real payments. The flag stays `lydia` (the
onboarding needs it), and it STAYS `lydia` after the user's test too (user, 2026-10-23): it is not set
back to `disabled`.

- **The recreate**: the core-service container alone, through the same compose file the deploy uses, with
  `LYDIA_ENV=production` in the environment of that one command. No file on the host was edited.
- **The rollback**: the same recreate with `LYDIA_ENV=homologation`, which puts the core back on the sandbox
  URL; paired with the production tokens it then fails loudly (Lydia answers "Provider inconnu", code 104)
  rather than moving money.
- **THE TRAP**: that value lives only in the running container. A deploy re-renders the production `.env`
  from the manifest, which carried no `LYDIA_ENV` before #2323, and recreates the core from it - so a
  deploy silently undoes the recreate and leaves the production tokens on the wrong base URL. **No stable
  and no deploy of any kind until #2323 is merged**: it makes `LYDIA_ENV` a required secret rendered with
  an allowed-values check.
- **While live**, anything unexpected is reported at once: a payment request nobody launched, an
  association other than the test one holding a Business, any callback arriving.

**Where the key came from until enrolment lot 1: the payout manager typed it** (now captured at
`business/create`, [below](#the-key-is-captured-at-businesscreate-enrolment-lot-1)). `PUT /api/associations/:id/lydia-business-key`
(`MANAGE_PAYOUT_ACCOUNT`, the permission of every other Lydia route) stores it ENCRYPTED in
`associations."lydiaBusinessKeyCiphertext"` (migration 100): AES-256-GCM (`common/secret-box.ts`)
under a key derived by HKDF from `LYDIA_KEY_ENCRYPTION_SECRET`, with `<associationId>:<vendorToken>` as
additional data, so a ciphertext copied to another row, or kept across a re-onboarding to another
Business, does not open. **Write-only:** `GET` on the same path answers `{ set }` and nothing else, the
PUT answers `{ set: true }`, the audit line names the association and the actor and never the value,
and the column is mapped `select`/`insert`/`update: false` so no entity read can carry it. Unlinking
the Business clears it. The copies of production strip it (`copy-strips.sh`) and a local estate
regenerates the secret (`env-from-prod.sh`), so a laptop with a dump cannot open one.

### The key is captured at `business/create` (enrolment lot 1)

`api_token_id` IS the Business private token (`auth/vendortoken`, homologation 2026-10-30,
[lydia-api](../../lydia-api.md#1-the-four-credentials-and-what-each-is-for)), and Lydia answers it once.
So the onboarding (`POST /api/payments/onboarding`, core-service) now:

1. **Refuses a re-run** while the association has a `lydiaAccountId`: a typed 409
   `LYDIA_ACCOUNT_ALREADY_LINKED`, read BEFORE `business/create`; social-service's link is one
   `UPDATE ... WHERE "lydiaAccountId" IS NULL`, so two concurrent onboardings cannot both link. The
   screen maps the code (`lydiaOnboardingRefusal.ts`) and re-reads the payout account.
2. **Proves the key** with `auth/vendortoken` (`vendor_token` + `vendor_id`). Only `status: "ok"` goes on.
3. **Links the Business WITH its key** (`POST associations/:id/lydia-account`, internal secret): the
   same column, encryption and binding as a pasted key, in the same statement as the vendor token. The
   browser receives the public pair only.

The payout account is read first, before anything is created: a 404 is an unknown association (refused,
nothing created) and a 5xx or a transport failure is the typed 503 `PAYOUT_ACCOUNT_UNREADABLE` - never
read as "not linked", which would invite a second `business/create`. A link refused with the body code
`LYDIA_ACCOUNT_ALREADY_LINKED` (a concurrent run won) is the same 409, classified on the code and not
on the status.

**What may be logged:** the `vendor_token` (`api_token`) is PUBLIC - it names a payment destination,
it is in every callback and on the manager's screen - so an ERROR line may carry it, and the orphan's
must. The Business private key (`api_token_id`, `vendor_id`) and every signature are secret and never
logged (`LYDIA_LOG_REDACT_KEYS` in `lydia-payment-provider.ts`).

#### An orphan Business: ONE typed outcome, and what an admin does

Every failure AFTER a successful `business/create` - `auth/vendortoken` unreachable or 5xx, error 103 or
any other Lydia code, a missing `api_token_id`, a link that fails for any reason but a concurrent run -
is ONE answer: the typed 502 `LYDIA_BUSINESS_CREATED_UNLINKED`. The Business exists at Lydia, Canari
links nothing, and the line logged at ERROR is

```
[LYDIA-ORPHAN] association <id>: Business vendor_token=<token> was created at Lydia and is NOT linked (<why>) ...
```

(a concurrent run that lost the link logs the same line before its 409: its Business is an orphan too).
The screen branches on the code and says not to retry and to contact a platform administrator.
**A retry can still create a second Business** - the association is not linked, so the 409 guard does
not stop it; the no-retry message and the admin path below are the mitigation, not a lock.

What the admin does: find the `[LYDIA-ORPHAN]` line for the association in core-service's log; give its
`vendor_token` to Lydia's support and ask them to delete that Business (the API has no delete call);
then let the association enrol again from its settings. Nothing is stored in Canari for an orphan, so
there is nothing to clean here. **No report scans these lines today** (the hourly reports read
databases, not core-service's log); a report that should would grep the tag `[LYDIA-ORPHAN]`.

**The webhook is a log line, by necessity.** `business/create` carries `webhook` =
`/api/payments/lydia-business-webhook` (public, multer-bounded, nginx zone `lydia_callback`). Its body
is unsigned and names a public vendor token, and Lydia has no read of a Business's validation state
that is not a real `request/do` - so the route WRITES NOTHING: it reads which association holds the
token (`internal/associations/lydia-business-of-vendor-token`, a SELECT) and logs
`[LYDIA-BUSINESS-WEBHOOK]` at INFO for `BUSINESS_VALIDATED`, WARN for `BUSINESS_UNVALIDATED` or
anything else, always answering 200. A global admin keeps "Valider l'onboarding". A spec drives every
event, a forged "complete" field and an oversized body through it and asserts no write.

**The paste field is gone** (production has no linked Business without a stored key, counted
2026-10-30). Old store builds still embed it, so `PUT lydia-business-key` stays as a shim: a typed
`410 LYDIA_KEY_PASTE_RETIRED`, nothing written, a WARN per hit - behind the old route's throttle and
`MANAGE_PAYOUT_ACCOUNT` check, so the WARN counts managers on an old build and not anonymous noise; the `GET` status those builds read stays
too ([legacy-compatibility](../../legacy-compatibility.md#no-date-yet---the-lydia-key-paste-field-of-a-build-older-than-enrolment-lot-1)).

**No key: no longer a reachable state** for a Business linked by the onboarding (lot 1 links it with
its key or not at all). Were one keyless anyway, every callback of that association is refused (400)
and a FORM payment is still confirmed when the payer comes back (`confirm-payment`).

**The secret is REQUIRED on both estates** (`env-manifest.tsv`, like `AGENDA_SIGNING_KEY`): a deploy
without `LYDIA_KEY_ENCRYPTION_SECRET` / `DEV_LYDIA_KEY_ENCRYPTION_SECRET`, or with one under 32
characters, fails its render naming the secret rather than starting a service that cannot store a key.

## Enrolment goes through Canari, and only through it (2026-10-23)

**The user's decision, 2026-10-23:** every association's Lydia Business is CREATED by Canari's
onboarding (`business/create` under Canari's Provider). Linking an account the association already holds
with Lydia is not offered, because the partnership with Lydia rests on the Businesses Canari's Provider
creates; a direct database edit could still link one, and is not to be done. Lydia does accept such an
older account under our Provider ([lydia-api](../../lydia-api.md#1-the-four-credentials-and-what-each-is-for)),
which is exactly why the rule has to be written rather than enforced by Lydia.

**The first production payment (2026-10-23)**, run by the user and the lead session: one real payment of
the minimum amount through an association's older Business, linked by hand for the test and unlinked
afterwards. The `confirm` callback reached Canari's route and verified with the pasted Business key. The
same day, two Businesses were created through the onboarding in production; neither is validated yet.

**What the enrolment screen does not say yet, and owes** (found by that run; the work package is in
[backlog](../../backlog.md#the-lydia-enrolment-and-cashier-chantier---decided-by-the-user-on-2026-10-30)):

- After `business/create` the card says "En attente" and offers "Ouvrir le tableau de bord Lydia", whose
  link answers 404 to anyone not signed in to Lydia's console. The manager is left with no next step.
- The path to validation is Lydia's activation e-mail (sign in to the console with the Lydia Pro app,
  upload documents, wait for Lydia); a NEW Business's holder reaches it once added by the
  Provider-signed `business/addcashier` (measured in production 2026-10-30), which Canari does not call
  yet - lot 3 ([lydia-api](../../lydia-api.md#activating-a-business-that-businesscreate-made-production-2026-10-23)).
- "Pending" cannot tell "waiting for Lydia" from "validated by Lydia, not yet marked here": the global
  admin's "Valider l'onboarding" is a declaration. Lydia's error 5 on `request/do` is the one measured
  signal of a Business not yet validated; the `BUSINESS_VALIDATED` webhook is now received and logged
  (lot 1), but, unsigned, it marks nothing.

## A product checkout is a row, one per attempt (2026-10-21)

**What broke (measured on dev, sandbox, 2026-10-21).** A boutique checkout sent Lydia the order_ref
`product:<productId>:<userId>`, the SAME string every time, and Lydia refuses a second `request/do`
carrying an order_ref it has seen (error 3, "order_ref deja utilise"). So after one declined or
expired attempt a product could never be bought again (a repeatable one only once), Canari's own
"already purchased" check never fired - nothing was ever recorded to fire it - and the shop showed
Lydia's raw error. Nothing on Canari's side held the request a purchase was waiting on, which is
also why a verified product callback fulfilled nothing (above).

**The attempt row** (`product_checkouts`, social-service migration `101`): product, buyer, the
product's association, the association whose account the request was issued to
(`paymentAssociationId` - itself, or its approved parent at the time) and that account's Lydia
Business (`vendorToken`, a snapshot: the request is read, cancelled and its callback checked with the
Business that HOLDS it, even after the association relinks another one), the amount in cents resolved
at checkout, a name snapshot, Lydia's `request_uuid` and numeric `request_id` (NULL until the issuing
call answers them), `expiresAt`, and `status` `open | paid | declined | expired | cancelled`. Only
`paid` counts as a purchase.

**The order_ref names the attempt, and no buyer**: `product:<productId>:<checkoutId>`, 81 characters,
parsed by core's `parseLydiaOrderRef` (`lydia-order-ref.ts`). It is shorter than the 109-character
two-part form Lydia was measured to accept, so its length is inside what was measured; the buyer is
the row's. The old `product:<productId>:<64-hex userId>` is NOT parsed and has no shim: the old parser
demanded a UUID user id, so no request ever issued with it was parseable either. The request is sent
`expire_time` = 30 min (`PRODUCT_REQUEST_LIFETIME_SECONDS`), so an abandoned attempt closes at Lydia
instead of staying payable at an old price.

**Reading an attempt at Lydia** (`readAndApplyRequestState`, through `payments/request-state`): by its
`request_uuid`, or - when the issuing call never answered one - by its order_ref, which Lydia's
`request/state` also finds (measured 2026-10-15, [above](#requeststate-the-payers-own-cancel-and-a-callback-that-is-parsed-2026-10-15-1830z)).
Only a lookup by order_ref may answer `not-found` (Lydia's error 2 "Requete introuvable", measured on
an unknown order_ref): that attempt's request/do never reached Lydia, and it closes `cancelled`.
`request-state` accepts only Canari's own product grammar there, never a free string. `paid` is
settled, state 5 closes `declined` (measured 2026-10-21), state 6 `expired` past `expiresAt` and
`cancelled` before it (the state alone cannot tell them apart), `open` and `unknown` change nothing.
The states are #2210's ONE typed mapping (`toRequestState` in `forms/seat-hold.ts`); `not-found` is
read before it because it answers a lookup, not a request. That closure is logged at WARN with the
order_ref.

**Opening an attempt** (`ProductsService.createCheckoutSession`), in this order:

1. **The buyer's previous OPEN attempt of this product is settled at Lydia** - cancelled by its
   numeric id (`payments/cancel-request`), or, when the cancel answers `already-settled` (error 2) or
   there is no numeric id, read: paid is RECORDED (no second request is issued), closed / declined /
   not found closes the row. An open row naming no request and written less than 3 minutes ago
   (`CHECKOUT_ISSUE_WINDOW_MS`, over social's 120 s call timeout) is being issued right now:
   `CHECKOUT_IN_PROGRESS` (409). Anything still unproven - Lydia answers open, the cancel or the read
   fails - refuses `PREVIOUS_CHECKOUT_OPEN` (409, "at most 35
   minutes"), and **that refusal ends**: past `expiresAt` + 5 min (`CHECKOUT_EXPIRY_MARGIN_MS`) the
   request was sent an `expire_time` that has run out, so the attempt is closed `expired` at ERROR and
   the buyer may retry. The margin covers Lydia's expiry being counted from the request's creation,
   a little after `expiresAt`.
2. **"Already purchased" is decided by Canari**, from `purchase_records`, before any request:
   `PRODUCT_ALREADY_PURCHASED` (409). A declined, expired or cancelled attempt is not a purchase.
3. **The row is written `open`**; a second open row for one product and buyer loses on the partial
   unique index `product_checkouts_one_open` (a double click) and is answered `CHECKOUT_IN_PROGRESS`.
4. **The request is issued.** A 4xx from core is an ANSWER (nothing was issued) and releases the row
   `cancelled` - an HTTP 4xx from Lydia itself included, which core answers as the same typed
   `PAYMENT_PROVIDER_REFUSED` 400 as an `error` code. Except 408, 409, 425 and 429
   (`LYDIA_HTTP_NOT_A_REFUSAL`): after those Lydia may have created the request, so they stay a LOST
   call - releasing an attempt that is then paid would be a second charge. A LOST call - a timeout, a 5xx, a 2xx without the ids - leaves it `open` with no ids,
   logged at ERROR. Core bounds its own call to Lydia at 60 s (`LYDIA_CALL_TIMEOUT_MS`, under the
   120 s social waits), so core always answers - a 5xx - before social gives up on it;
   Lydia may hold the request all the same, so it is read by its order_ref at the
   buyer's next attempt, return or confirm callback, never closed on a guess. The return URLs carry
   `checkout_id`, `association_id` and `productId`.

**Settling** is ONE path, `settlePaidCheckout`: the row is locked (`FOR UPDATE`), and its move to
`paid`, the purchase record and the granted tag commit together - a second `paid` answer (the
callback and the return, or two return reads) finds `paid` under the lock and records nothing.
**Measured against a real PostgreSQL** (`product-checkout.integration.spec.ts`, gated on
`SOCIAL_IT_DATABASE_URL`): eight concurrent settlements of one attempt write ONE record, and with the
lock removed the same test wrote three. Product, buyer and amount are the ROW's, never the callback's
or the return query's. A `paid` answer over a CLOSED row is still recorded (the money was taken) and
logged at ERROR: the buyer may have paid a later attempt too, so for a non-repeatable product it is
very probably a second charge for a human to refund. The Cercle top-up is dispatched after the commit.

**The payment id** recorded (`purchase_records.stripePaymentIntentId`, the tag's `paymentIntentId`,
the top-up's) is the numeric `request_id`, which `request/state` never answers. A lost request/do
leaves the row without it, so a verified callback STORES its `request_id` on the row before the row is
settled (`storeCallbackRequestId`, conditional on the column being NULL; a row holding another id is
refused at ERROR). An attempt the payer's return settled first, with no id yet, is recorded with none
and - for a top-up - logged at ERROR, "top-up NOT dispatched"; the callback then completes it
(`completePaidWithoutRequestId`, run on EVERY paid outcome of a callback: its row read is unlocked,
so the return may settle the attempt between that read and the callback's own settlement, which then
finds it paid and records nothing - a real-PostgreSQL test drives exactly that interleaving): the record takes the id while it is still NULL, and only the call
that wrote it dispatches the top-up - eight racing completions against a real PostgreSQL write it
once (the control without `IS NULL` wrote it eight times). The tag's `manualGrant` says how the
purchase was PAID (cash or online), never inferred from a missing id.

**Who triggers it.** The reconciliation sweep, for an attempt still `open` once its request has
ended, on a VERIFIED answer only ([lydia-api](../../lydia-api.md#7-reconciliation---the-sweep-lydias-documentation-asks-for):
`applyRequestState`, the one mapping the return and the callback use) - an attempt whose read gave
a FINAL answer it cannot act on (a mismatch, unsigned, no usable key, a refusal on the allowlist) is
closed `expired` (`expireUnprovenCheckout`), which only a later callback still records over; one Lydia
says is still open is cancelled there first; no answer, a fault of core, a refusal not known final or a
failed write leaves it open for the next tick. The payer's return: the shop page polls
`POST /api/associations/:id/products/:productId/checkouts/:checkoutId/confirm` while the attempt
is open (at most 10 reads, 3 s apart, throttled per user and attempt like the form's
`confirm-payment`) and says paid / still waiting / declined / not completed through Paraglide
(`$lib/shop/checkoutReturn.ts`). Only the buyer's own attempt of that product of that association
is found. **And Lydia's verified confirm callback** (`webhook.controller.ts`, changed by this lot:
the product branch that logged "NOT fulfilled" now hands the attempt over) - core posts
`{ checkoutId, requestId, vendorToken }` to social's internal `products/:productId/purchase-completed`.
A TRIGGER ONLY: the attempt is found by the id its order_ref carries, so one whose ids were never
stored is found too; it must be of that product, the verified Business must be the account the
attempt was issued to (the row's `vendorToken` - an authentic callback of association A never settles
B's attempt, and neither does a Business the association linked after the issue), and `requestId` must
not be another request than the one the attempt stored. Each refusal is logged at ERROR and reads nothing. Then the attempt is read at
Lydia like the return does, even when closed. No buyer and no amount cross. A read that fails answers
`unreadable`, which core turns into the 503 Lydia retries. A verified product cancel or expire is
logged and applies nothing: the attempt is read at its next return, retry or confirm.

**Not measured:** the
confirm callback of a PAID boutique request end to end, the 81-character order_ref itself at Lydia
(only the 109-character form was), and the deep-link return on a phone. **Known and not closed
here:** a request/do that reaches Lydia after core's 60 s bound (Lydia's own processing, not
Canari's wait) may still create a request after the 3-minute window; if that attempt was meanwhile
read `not-found` and closed, a payment for it is still recorded by its callback (paid over a closed
row, at ERROR). A crash between a top-up's commit and its Cercle dispatch loses the dispatch with no
line ([backlog](../../backlog.md#p2---a-crash-between-a-top-ups-purchase-commit-and-its-cercle-dispatch-loses-the-top-up-silently-review-of-2218-2026-10-21)).
Concurrent attempts of DIFFERENT buyers can still oversell `maxPurchasesTotal`, as before this lot.

## A form answer sends one order_ref per request (2026-10-27)

**What broke.** The boutique's defect above, on forms: a paid answer's retry (after a declined,
cancelled or expired request) REUSES its live pending row (`FormsService.submit`), and every request
of that row carried the same order_ref `form:<submissionId>`, which Lydia refuses on the second
`request/do` (error 3, measured 2026-10-21, [lydia-api](../../lydia-api.md#requestdo---ask-a-payer-for-money)).

**The fix needs no migration.** `formOrderRef` (social-service `forms/form-order-ref.ts`) sends
`form:<submissionId>:<8 hex digits>`, 50 characters (`FORM_ORDER_REF_MAX_LENGTH`, pinned by a test),
32 random bits per request. Lydia documents no maximum length, so the string is kept short and well
inside the 109 characters measured accepted ([lydia-api](../../lydia-api.md#requestdo---ask-a-payer-for-money));
the submission id keeps it unique across answers, and the attempt part only has to differ between the
few requests of one answer. The attempt part is NOT
stored, because nothing reads a form request by its order_ref: every read, cancel and settle goes
through the row's own stored ids (`paymentRequestId`, `stripeSessionId`), unlike a boutique attempt
whose issuing call may never have answered them. Core's `parseLydiaOrderRef` returns only the
submission for both this grammar and the legacy `form:<submissionId>` (requests open at the deploy
still call back with it), so a callback about an OLD request names the same row and is decided as
before: a cancel for a request the row no longer names is `other-request`, a confirm reads the row's
CURRENT request and accuses at ERROR the request it does not name. `markPaid` stays the one writer
of `paid`. Proven on PostgreSQL by `form-order-ref.integration.spec.ts`.

**Not measured at Lydia:** a sandbox run on 2026-10-27 could not reach the order_ref check - a fresh
sandbox Business answers error 5 first ([lydia-api](../../lydia-api.md#requestdo---ask-a-payer-for-money)) -
so the 50-character form order_ref and the second request of one submission are owed a run with a
validated sandbox Business.
