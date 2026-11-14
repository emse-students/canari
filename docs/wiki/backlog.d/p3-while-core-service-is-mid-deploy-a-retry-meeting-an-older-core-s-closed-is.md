## P3 - while core-service is mid-deploy, a retry meeting an older core's `closed` is refused (review of #2215, 2026-10-21)

target: 1.9.0

Since #2210 social-service reads a request state through `toRequestState`, which knows `open | paid | declined | cancelled-or-expired | unknown`. An OLDER core-service still answering `closed` for state 6 during a deploy is read as `unknown` (one WARN, `readRequestState`'s wire-mismatch line), so a retry's `settleOpenRequest` refuses it with 409 `PREVIOUS_PAYMENT_OPEN` (WARN) instead of freeing the row. Deliberate (a deploy in either order refuses rather than releases) and TEMPORARY: it ends when the new core serves. **Owed:** nothing unless a deploy is observed to leave payers refused past the core restart - then check the deploy order rather than teach social-service the old word.

_Context, from the former backlog section "Payments":_ Lydia ("Paiement Canari") and cash are the only payments since Stripe was removed (#1589, [stripe-archive](../stripe-archive.md), which lists the names kept for rollback and old clients). `payment_provider` is `lydia | disabled`, default `disabled`; mechanism in [payments](../frontend/modules/payments.md) and [core-service](../services/core-service.md#payments-stripe--lydia).
