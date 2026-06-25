# Forms module

**Routes**: `src/routes/forms/[id]/`  
**Components**: `src/lib/components/forms/`

## Responsibilities

- Render dynamic association forms for member submissions.
- Support optional online payments (Stripe Checkout) or cash payments.
- Display submission confirmation and payment status.

## Form submission flow

```
/forms/:id
  -> GET /api/forms/:id (form definition: fields, basePrice, allowCashPayment)
  -> User fills form
  -> POST /api/forms/:id/submit { answers, paymentMethod }

If basePrice > 0 and online payment:
  -> POST /api/payments/create-checkout-session
  -> Redirect to Stripe Checkout
  -> On return: POST /api/payments/verify-session

If cash payment:
  -> Submit marked as "pending cash"
  -> Association admin validates/cancels via EditFormsTab
```

## Payment methods

| Method | Flow |
|---|---|
| Free | Direct submit, no payment |
| Stripe Checkout | Redirect to Stripe-hosted page, return to `/forms/:id?session_id=...` |
| Saved card | `POST /api/payments/charge-saved-method` (no redirect) |
| Cash | Submit marked pending, association admin validates manually |

## Key component: forms/[id]/+page.svelte

The single form submission page handles all four payment flows. Key state:
- `form` — form definition loaded on mount
- `answers` — user-provided field values
- `paymentStep` — `'form' | 'payment' | 'confirmation'`
- Card registration setup: `POST /api/payments/setup-payment-method` (Stripe SetupIntent)

## Note on form creation

Forms are **created and managed** by association admins inside the associations module (`edit/EditFormsTab.svelte`). The forms module covers only form **submission** by end users.
