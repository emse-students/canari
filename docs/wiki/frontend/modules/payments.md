# Payments module

**Routes**: `src/routes/shop/`  
**Components**: `src/lib/components/payments/`, `src/lib/components/shop/`

## Responsibilities

- Boutique: browse and purchase association products.
- Stripe Checkout for product purchases.
- Saved card management (setup, list, charge, detach).
- Purchase history.

## Which payment provider is live

**Stripe is no longer addressed directly.** A `PaymentProvider` interface
(`apps/core-service/src/payment/payment-provider.interface.ts`) sits between `PaymentService` and the
processor, with two implementations behind it: `stripe-payment-provider.ts`, a pure extraction of
what was already there, and `lydia-payment-provider.ts`.

Which one is active is a **platform admin setting read from Postgres per call**, not an environment
variable and not a startup decision - so flipping it in `/admin/platform` takes effect with no deploy
and no restart. **The default is still Stripe**, and production has not moved. The frontend asks
**`GET /api/payments/provider`** which is live and renders the matching onboarding flow, because the
two differ: Stripe hosts its own onboarding page, while Lydia needs the club's legal profile
collected by Canari and posted to `business/create`.

Only the flows that map cleanly onto the interface exist on the Lydia side today (one-off checkout,
session lookup). Everything else - live balance and status, saved payment methods - **throws a
documented error rather than faking a result**: Lydia has no live status-poll endpoint, and saved
payment methods are being retired outright rather than reimplemented, so every purchase becomes its
own interactive request.

The full provider mapping, the open questions and the credentials still owed are in
[`plans/stripe-to-lydia-migration.md`](../../../../plans/stripe-to-lydia-migration.md) (WP-LYDIA-1).
The sections below describe the **Stripe** path, which is what runs today.

## Where a provider's name may appear, and where it may not

The interface above only pays off if the vendor's name stops leaking through it, and on 2026-08-30 it
still did in four places. The rule the pass settled on: **a provider's name is true in exactly one
layer**, and it stays wherever it is a fact.

**It was removed from:**

- **The message catalogue** - 61 Paraglide keys in `fr.json` / `en.json` said Stripe. They now say
  "prestataire de paiement" / "payment provider", or nothing at all where the sentence did not need
  one. Zero keys mention a vendor.
- **Three user-visible strings that were NOT in the catalogue**, and so survived that sweep: the
  `<h2>` of the association payments panel, which read the raw words `Stripe Connect`; a `title=`
  attribute in `EditFormsTab`; and three `error = err instanceof Error ? err.message : '...'`
  fallbacks in the association edit page. All five are Paraglide keys now.
- **The provider-agnostic contract.** `PaymentProvider.getConnectAccountStatus` returned a
  `StripeConnectStatusResponse` imported from the Stripe module - so `LydiaPaymentProvider` imported
  Stripe to declare what it returns. The shape was already neutral; only the name was not. The type
  is now `ConnectAccountStatusResponse` and lives in `payment-provider.interface.ts`, which owns the
  vocabulary. The frontend mirror of it (`src/lib/associations/api.ts`) was renamed to match.
- **Log tags on neutral paths.** `[Stripe] Checkout session created` sat on the shared controller and
  would have printed for a Lydia checkout. Those two are `[Payments]`. The four inside
  `StripePaymentProvider` keep the name, because that class IS Stripe.

**It was deliberately KEPT in:**

| What | Why renaming it is a migration, not a rename |
| --- | --- |
| `stripeAccountId`, `stripeOnboardingComplete` | per-provider columns; migration 037 gave Lydia its own pair beside them |
| `MANAGE_STRIPE_CONNECT` / `canManageStripeConnect` | a persisted association permission flag |
| `STRIPE_WEBHOOK_SECRET` | an environment variable, and Stripe's |
| `stripe_return=1` | the query param an onboarding already in flight will come back with |
| `stripeFees.ts`, `deriveStripeConnectStatus`, `buildStripeConnectStatusResponse` | the arithmetic and the mapping really are Stripe's; a neutral name here would be the lie |

**`StripeNetPayoutHint` is gone from this row (2026-09-18)**, and for the same reason the row
exists: once Lydia's fee (0,10 € + 1 %, confirmed by Lydia) got its own module (`lydiaFees.ts`,
correctly still Stripe-shaped in name terms - its arithmetic really is Lydia's), the COMPONENT
that renders either one is no longer single-provider arithmetic wearing a neutral name; keeping
"Stripe" in it would have become the lie this table is about. It is `PayoutFeeHint.svelte` now,
and picks its fee module by asking `GET /api/payments/provider` - the cheaper of the two options
this page used to leave open, needing no change to `PaymentProvider` itself.

## Product purchase flow

```
/shop or /associations/:id (boutique tab)
  -> GET /api/associations/:id/products
  -> User clicks "Buy"
  -> POST /api/associations/:id/products/:productId/checkout
     -> core-service creates Stripe Checkout session
  -> Redirect to Stripe-hosted page
  -> On return: payment confirmed in webhook (core-service POST /api/payments/webhook)
```

## Saved card flow

Users can save a payment method for faster checkout:

```
POST /api/payments/setup-payment-method
  -> Returns Stripe SetupIntent
  -> User enters card in Stripe Elements
  -> Card saved as PaymentMethod in Stripe

Future checkout:
  POST /api/payments/charge-saved-method { paymentMethodId, amount, formSubmissionId }
```

## Components

| Component | Role |
|---|---|
| `shop/ProductCard.svelte` | Product listing card |
| `shop/ProductPurchaseButton.svelte` | Buy button with loading state and success toast |
| `payments/SavedCardsList.svelte` | List of saved cards with detach |
| `payments/AddCardForm.svelte` | Stripe Elements card setup form |

## Routes

| Route | Description |
|---|---|
| `/shop` | Global boutique (all associations' products) |
| `/shop/[productId]` | Product detail |

## Key API endpoints (core-service)

| Endpoint | Description |
|---|---|
| `POST /api/payments/create-checkout-session` | Stripe Checkout for forms |
| `POST /api/associations/:id/products/:productId/checkout` | Stripe Checkout for products |
| `POST /api/payments/setup-payment-method` | Setup saved card |
| `GET /api/payments/payment-methods` | List saved cards |
| `DELETE /api/payments/payment-methods/:id` | Detach saved card |
| `POST /api/payments/charge-saved-method` | Charge saved card |
| `POST /api/payments/charge-product-saved-method` | Charge saved card for product |
| `POST /api/payments/verify-session` | Unguarded. Re-reads a Checkout session from Stripe and marks the linked submission paid **only if Stripe says `paid`** |
| `POST /api/payments/cancel-session` | Unguarded. The mirror: marks the submission cancelled, refusing outright if the session WAS paid |
| `POST /api/payments/webhook` | Stripe's own confirmation, signature-verified |

## Two paths confirm a Stripe payment, and only one of them is authoritative (2026-08-31)

**A payment is confirmed twice on purpose, and for four days only the weaker of the two worked.**

`POST /payments/webhook` is the authoritative path: Stripe posts it whether or not the buyer's
browser ever comes back. `POST /payments/verify-session` is the browser-return path, called when the
buyer lands back on the site; it asks Stripe for the session, refuses anything Stripe does not call
`paid`, and then does exactly what the webhook would have done.

### The failure, and why nothing saw it

The webhook verified signatures with `stripe.webhooks.constructEvent` - the SYNCHRONOUS form. The
runtime is `bun dist/main.js`; **bun matches the `worker` export condition**, stripe-node maps that
to its web build, and its crypto provider is `SubtleCryptoProvider`, which has no synchronous digest
and therefore throws by construction:

```
ERROR [PaymentWebhookController] Webhook signature verification failed
SubtleCryptoProvider cannot be used in a synchronous context.
Use `await constructEventAsync(...)` instead of `constructEvent(...)`
```

Every delivery since at least 2026-08-27 was answered 400. Measured on 2026-08-31: **24 rejections
and 0 acceptances over the container's whole life**, and **38 events still undelivered at Stripe, 12
of them `checkout.session.completed` on a LIVE key**.

**Eleven of those twelve buyers were rescued by the browser-return path**, which is precisely why a
total failure of the authoritative path was invisible for four days. That is the shape the standing
rule names: a fallback carrying production is a signal, never a path. The twelfth buyer closed the
tab after paying; nothing else existed to record their 130,00 EUR, and their submission sat
`pending` - with no cotisation tier and no purchase record - until it was repaired by hand.

### What the fix is, and what it is not

`constructEventAsync` is the same verification on **either** provider, so the call site is one path
rather than a branch on which build got resolved. Pinning a crypto provider, or forcing the node
build through an export condition, would both have been a fallback: they make the synchronous call
work again instead of removing the reason it could not.

**A test on node cannot catch this class.** Jest runs on node, where the same sdk resolves the NODE
build and `constructEvent` would have passed - so `webhook.controller.spec.ts` pins the
provider-dependent fact itself, asserting that `constructEvent` THROWS under
`Stripe.createSubtleCryptoProvider()` and that `constructEventAsync` accepts the same payload. If a
later edit puts the synchronous call back, the two controller tests stay green and only that one
says why production would not.

### Repairing a payment the webhook missed

Never by an `UPDATE`. `verify-session` is the repair, because it re-reads the session from Stripe
before writing anything, and because `markPaid` in social-service does three things, not one:

| Effect | Table |
| --- | --- |
| the submission's status | `submissions.paymentStatus` |
| **the cotisation tier**, when the form sets `grantsCotisation` | `user_tags`, e.g. `cotisant:bde` |
| the accounting row | `purchase_records` |

A hand-written status update produces the first and silently skips the other two. The granted tag
carries `{sessionId, submissionId}` in its `metadata`, so a repair stays distinguishable from an
ordinary grant afterwards.

## Payment delegation (parent-association routing)

An association that has no Stripe Connect account of its own (or simply wants a parent to collect
on its behalf) can **delegate** its online payments to a **parent association**. When approved,
**all** of the child's online payments - shop products, paid forms, paid posts - are charged onto
the parent's Stripe Connect account instead. The child keeps its own "association" identity in the
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
  child also has its own Stripe account.
- **One level only.** A parent that itself delegates cannot be chosen as a parent (no chains), and
  an association that already receives delegated payments cannot delegate its own.
- **Fails closed.** If a delegating child's parent can't be loaded, or the parent has not finished
  Stripe onboarding, payments are treated as *not ready* rather than falling back to the child.

### Routing decision point

`resolvePaymentTarget(asso, parent)` in
`apps/social-service/src/associations/payment-delegation.util.ts` is the **single** pure function
that decides where a payment goes. Every payment path in social-service
(`products.service` checkout/charge/`isActive`, `forms.service`, `posts.controller` paid posts)
resolves its Stripe account through it, so routing stays consistent. core-service just executes the
charge against whatever `stripeConnectAccountId` it is handed.

The purchase record still carries the **child's** `associationId`, so the Canari DB remains the
accounting source of truth even though the money lands in the parent's Stripe pot.

### Parent accounting access

Approving a child grants the parent read access to that child's accounting (purchase records + paid
form payments), including an `.xlsx` export. These are **parent-scoped** endpoints: the route id is
the parent (so the existing `MANAGE_PRODUCTS` guard proves parent-admin), then the service verifies
the approved link via `assertIsApprovedParentOf`. The parent does **not** get the child's Stripe
dashboard or balance.

### UI

`/associations/[slug]/edit` -> **Delegation** tab (`edit/EditDelegationTab.svelte`, gated on
`MANAGE_PRODUCTS`). One component, two sections:

- **Club-side** - pick a parent association, request delegation, and see status (`pending` /
  `approved`, with a warning if the parent isn't Stripe-ready) or cancel.
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
| POST | `/api/associations/:id/payment-delegation/children/:childId/approve` | Approve a child (parent must be Stripe-ready) |
| POST | `/api/associations/:id/payment-delegation/children/:childId/reject` | Reject/revoke a child |
| GET | `/api/associations/:id/payment-delegation/children/:childId/purchases` | Read a delegated child's purchases |
| GET | `/api/associations/:id/payment-delegation/children/:childId/purchases/export` | Child's purchases as `.xlsx` |
| GET | `/api/associations/:id/purchases/export` | Own purchases as `.xlsx` |

## See also

- [associations.md](associations.md) - association model, permission flags, admin panel tabs.
- [../../cotisations.md](../../cotisations.md) - membership dues (also routed through Stripe Connect).
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

Stripe replaces `{CHECKOUT_SESSION_ID}` in a return URL when it redirects; **Lydia does not**, so a
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

Stripe and Lydia keep independent account ids and `*OnboardingComplete` flags (migration 037), so
"is this association ready" is a question about the ACTIVE provider. `isPaymentAccountReady(asso,
provider)` in `lib/associations/api.ts` is the one answer; the provider comes from
`activePaymentProvider.svelte.ts` (fetched once, `null` until known and on failure - which reads as
not ready and logs at error level, never as Stripe). The edit page's boutique/forms warnings, the
paid-form recipient gate and the delegation tab all read it; before, they read the Stripe flag only
and a Lydia association whose flag was `true` in the database still showed as incomplete. The Lydia
card shows Pending until `lydiaOnboardingComplete` is true, then Active (nothing sets it
automatically yet - see the core-service page).

**Manual validation.** A GLOBAL ADMIN sees "Valider l'onboarding" on the Lydia card while the flag is
false (`POST /api/payments/complete-lydia-account/:associationId`, `NginxAuthGuard` +
`GlobalAdminGuard`, refused without a linked Lydia account). It calls social-service's existing
`lydia-complete`, which also releases withheld products. Not open to the club's own managers: they
would be declaring their own account ready. Removal of Lydia (`disconnect`) resets it.

## The platform can declare payments DISABLED (2026-10-05)

`platform_config.payment_provider` takes a third value, `disabled` (admin platform page, "Paiements
desactives"; `VARCHAR(16)` holds it, no migration). Core-service answers it with
`DisabledPaymentProvider`: `isConfigured()` is false, so every route gated on it gives its existing
"not configured" answer, and anything that reaches the provider anyway fails with a 400,
`Payments are disabled on this platform`. `GET /api/payments/provider` returns `{provider:'disabled'}`.

It is NOT a kill switch for money already moving: the Stripe webhook and the Lydia request callback
verify with their own secrets, independent of the active provider, so a payment in flight still
completes. Social-service's `fetchActivePaymentProvider` returns the real value (it used to map
anything but `lydia` to `stripe`), and `resolvePaymentTarget` resolves `disabled` to not ready with no
account id - a ready Stripe or Lydia account, delegated or not, never routes. The client agrees:
`isPaymentAccountReady` is false, the association payments card shows the existing "no provider
configured" line instead of an onboarding flow, and `PayoutFeeHint` renders nothing.
