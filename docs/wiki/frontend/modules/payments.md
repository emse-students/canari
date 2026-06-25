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
