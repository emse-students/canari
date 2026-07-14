# Payments module

**Routes**: `src/routes/shop/`  
**Components**: `src/lib/components/payments/`, `src/lib/components/shop/`

## Responsibilities

- Boutique: browse and purchase association products.
- Stripe Checkout for product purchases.
- Saved card management (setup, list, charge, detach).
- Purchase history.

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
