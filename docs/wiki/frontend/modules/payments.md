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
  -> On return: confirmed by lydia-request-callback (core-service)
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
| `POST /api/payments/verify-session` | Unguarded. Re-reads the request from the provider and marks the linked submission paid **only if the provider says paid** |
| `POST /api/payments/cancel-session` | Unguarded. The mirror: marks the submission cancelled, refusing outright if the session WAS paid |
| `POST /api/payments/lydia-request-callback` | Lydia's own confirmation |

**A payment is confirmed twice on purpose**: the callback is authoritative (it fires whether or not
the buyer's browser returns), `verify-session` is the browser-return path and does exactly what the
callback would have done. Repair a payment the callback missed through `verify-session`, never by an
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
request does), the success page reads the submission and keeps asking while it is `pending` (the
callback may land after the redirect; `paymentReturnVerdict` is the one rule, at most 10 reads 3 s
apart, then an honest "awaiting confirmation" instead of an error), and the cancel page cancels that
pending submission. The boutique needs none of this: its return URLs carry no session id and its
fulfilment is the callback.

**Not verified, and owed to Lydia or a phone**: whether Lydia appends parameters to
`browser_success_url`, whether it accepts the `fr.emse.canari://` deep link the phone app sends,
and the mobile deep-link branch itself (`hooks.client.ts` reads `submission_id` now). A return URL
you see in a test is the one the request was created with: a link made by hand with `/ok` and
`/ko` returns there, which is how a test once ended on `/ko`.

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
