## P2 - an answer whose Lydia request is still OPEN shows "pending" with no button for up to 28 minutes (2026-10-21)

target: 1.8.0

A payer who leaves Lydia's page without paying or declining (tab closed, back button) leaves the request in state `0`: the form page reads "En attente" with the pay button disabled until the request expires (1680 s) or the hold ends (30 min). A retry would work server-side (`settleOpenRequest` cancels the open request and issues a new one), but the page offers none. #2210 covers declined and expired requests only ([forms](../frontend/modules/forms.md#a-declined-payment-releases-the-answer-2026-10-21)). **Owed:** a decision on offering "pay again" on an open request, and its two-tab hazard (the retry cancels the request another tab may be paying).

_Context, from the former backlog section "Payments":_ Lydia ("Paiement Canari") and cash are the only payments since Stripe was removed (#1589, [stripe-archive](../stripe-archive.md), which lists the names kept for rollback and old clients). `payment_provider` is `lydia | disabled`, default `disabled`; mechanism in [payments](../frontend/modules/payments.md) and [core-service](../services/core-service.md#payments-stripe--lydia).
