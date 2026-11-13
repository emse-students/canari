## P2 - a crash between a top-up's purchase commit and its Cercle dispatch loses the top-up silently (review of #2218, 2026-10-21)

target: 1.8.0

Three ways lose a top-up WITHOUT a line, and none of them credits twice:

- **The crash.** `settlePaidCheckout` (and `completePaidWithoutRequestId`) commit the purchase record, THEN `dispatchCercleWebhook` saves the `webhook_deliveries` row, outside that transaction. A process killed between the two leaves a paid top-up with no delivery row: the `*/5` scheduler (`retryDueWebhookDeliveries`) only retries `failed` rows that carry `nextAttemptAt`, so nothing retries it, and nothing logs it. **Why it was not built in #2218:** writing the row `pending` inside the settle transaction (an outbox) is not enough by itself - the scheduler would then have to tell "a dispatch is running" from "a dispatch died", and today only a clock could say which. Using a clock for that risks crediting the Cercle twice. The outbox needs a durable claim on the row (who is sending it), which is its own change.
- **A commit whose acknowledgement is lost**, or a process that dies after the commit and before the dispatch: the record is written and carries its id, so a retry (the callback again, or the next return read) finds the attempt `paid` and dispatches nothing.
- **Lydia answers `open` to a callback that said confirmed** (its state lagging its own callback): `readAndApplyRequestState` returns that stale `open`, so the callback skips `completePaidWithoutRequestId` and an attempt the return had already settled without an id keeps a record with no id and no dispatch.

**Recovery query, until then** - read-only. It returns every paid online top-up with no delivery row, which covers all three cases. A record still without an id (the third case) is included, because `NULL` matches no delivery. **Run on a throwaway local PostgreSQL only, never on production** (2026-10-21): its schema came from the entities, with four top-up records: three paid online (one with a matching delivery, one unmatched, one with no id) and one paid in cash. The query returned exactly the unmatched one and the id-less one.

```sql
SELECT pr.id, pr."userId", pr."amountCents", pr."stripePaymentIntentId", pr."paidAt"
FROM purchase_records pr
JOIN association_products p ON p.id = pr."productId" AND p.type = 'balance_topup'
WHERE pr.status = 'paid' AND pr."paymentMethod" = 'online'
  AND NOT EXISTS (SELECT 1 FROM webhook_deliveries d WHERE d."paymentIntentId" = pr."stripePaymentIntentId");
```

**Not covered by it:** a confirmed callback answered `open` for an attempt nobody had settled leaves NO record at all. Core answers Lydia 200, so the callback is not retried. Only a later return read, or the buyer's next attempt, finds the payment.

**Owed:** the outbox with a claim, and a report that runs this query - a mechanism with no report is found by hand. A row with a NULL `stripePaymentIntentId` is the id-less case that Lydia's confirm callback completes ([payments](../frontend/modules/payments.md#a-product-checkout-is-a-row-one-per-attempt-2026-10-21)).

_Context, from the former backlog section "Payments":_ Lydia ("Paiement Canari") and cash are the only payments since Stripe was removed (#1589, [stripe-archive](../stripe-archive.md), which lists the names kept for rollback and old clients). `payment_provider` is `lydia | disabled`, default `disabled`; mechanism in [payments](../frontend/modules/payments.md) and [core-service](../services/core-service.md#payments-stripe--lydia).
