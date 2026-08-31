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
| `stripeFees.ts`, `StripeNetPayoutHint`, `deriveStripeConnectStatus`, `buildStripeConnectStatusResponse` | the arithmetic and the mapping really are Stripe's; a neutral name here would be the lie |

The last row carries one open consequence: **the payout estimate is Stripe's fee schedule rendered
under provider-neutral wording**, so it would be wrong the day Lydia goes live. That is a tracked P2
in [backlog](../../backlog.md), not something this pass fixed.

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
