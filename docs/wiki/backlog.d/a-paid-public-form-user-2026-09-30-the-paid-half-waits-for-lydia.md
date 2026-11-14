## A PAID PUBLIC FORM (user, 2026-09-30) - the paid half waits for Lydia

target: 1.8.0

The free half is shipped (`/f/:id`, migration 068, [forms](../frontend/modules/forms.md#a-public-form-is-answered-without-an-account-2026-09-30)). **Owed:** one guest answer sent from a private window on `dev.canari-emse.fr`, with the `canari-dev-frontend-1` log showing a real client address rather than the Docker gateway (the `real_ip` change it carries); the paid half is scoped on [forms](../frontend/modules/forms.md#the-paid-half-what-it-needs-scoped-2026-09-30); Lydia is live in production (WP-LYDIA-1), so what it still needs is its own work packages and the guest payment readings.

_Context, from the former backlog section "Payments":_ Lydia ("Paiement Canari") and cash are the only payments since Stripe was removed (#1589, [stripe-archive](../stripe-archive.md), which lists the names kept for rollback and old clients). `payment_provider` is `lydia | disabled`, default `disabled`; mechanism in [payments](../frontend/modules/payments.md) and [core-service](../services/core-service.md#payments-stripe--lydia).
