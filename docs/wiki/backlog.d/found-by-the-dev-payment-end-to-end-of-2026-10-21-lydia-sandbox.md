## Found by the dev payment end-to-end of 2026-10-21 (Lydia, sandbox)

target: 1.8.0

**Re-read 2026-11-11.** The three P1s, two P2s and two P3s this run found shipped in `v1.4.0` (#2210,
#2215, #2218, #2205, #2208, #2209). The re-run of the onboarding over a linked Business is refused
since enrolment lot 1 ([the enrolment chantier](the-lydia-enrolment-and-cashier-chantier-decided-by-the-user-on-2026-1.md)).
What Lydia has not yet shown (a refund's success path, the default `expire_time`, the callback key) is
listed once, in [lydia-api section 6](../lydia-api.md#6-still-unknown) and lot 4 of that chantier.

Left here, P3: **a product with no price can be created**, and its checkout answers 400 with no log.
`ProductsService.create` checks only that the custom bounds are ordered; nothing refuses a product
with neither a fixed `amountCents`, nor a free amount, nor a priced grid. Owed: one refusal at create
and at update, typed, with the editor's sentence, and a test
([payments](../frontend/modules/payments.md)).
