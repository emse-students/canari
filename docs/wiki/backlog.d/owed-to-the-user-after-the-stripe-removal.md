## Owed to the user after the Stripe removal

target: 1.8.0

Delete the GitHub secrets `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PUB_KEY` and the Stripe webhook endpoint (the CGU and privacy text naming Lydia was APPROVED by the user on 2026-10-08). Three later items: the unsigned Lydia partnership contract, proof the payer e-mail is not kept, and association enrolment with conditions and uploaded documents. Later, once the previous release is no longer a rollback target: drop the three Stripe columns and rename the permission with a data migration ([stripe-archive](../stripe-archive.md#the-names-that-outlived-the-processor---what-2026-10-09-renamed-and-what-stays)).

_Context, from the former backlog section "Payments":_ Lydia ("Paiement Canari") and cash are the only payments since Stripe was removed (#1589, [stripe-archive](../stripe-archive.md), which lists the names kept for rollback and old clients). `payment_provider` is `lydia | disabled`, default `disabled`; mechanism in [payments](../frontend/modules/payments.md) and [core-service](../services/core-service.md#payments-stripe--lydia).
