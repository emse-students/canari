## The Lydia enrolment and cashier chantier - decided 2026-10-30, lots 1-4 shipped, what is left (audited 2026-11-19)

target: 1.10.0

**Shipped:** lot 1 (signed outgoing calls, the key captured at creation, the webhook, re-run refused, existing Businesses migrated), lot 2 (the step-by-step screen, the Responsable, readiness from the webhook and from error 5 / 2701, the enrolment-in-flight marker `lydiaEnrolmentStartedAt`, migration 118), lot 3 (the Tresorier and Vendeur cashiers: adding, changing a role and the Responsable's number change are ON since 1.7.1, owner 2026-11-18) and lot 4 (total and partial refunds, migration 120). Mechanism and every decision of the chantier (the three roles, the sealed phone, `lydia_cashiers`, register entry C23, the revoke counted only on "0 rights"): [payments](../frontend/modules/payments.md#enrolment-goes-through-canari-and-only-through-it-2026-10-23), [the cashiers](../frontend/modules/payments.md#the-cashiers-enrolment-lot-3), [refunds](../frontend/modules/payments.md#refunds-from-canari-enrolment-lot-4), [lydia-api](../lydia-api.md).

**Owed:**

- the SUCCESS path of a refund, measured once: a validated sandbox Business's payment, or the first production refund read in its logs (none could be made on 2026-10-31);
- one switch that is OFF: the payer's refund notice (`LYDIA_REFUND_NOTIFICATIONS_ENABLED`);
- one Business waits on the owner (decided 2026-10-31): **Le Cercle** is untouched, not even the read-only recording of its Responsable, until it is re-enrolled cleanly through Canari (it already has cashiers of its own). **Les Rootz** has no Lydia account, so nothing is re-enrolled (below).

**Not in scope, decided:** payouts to people (`payment/send`); ease of payment (instalments), a question to Lydia first (still offered, instalments, fees, who bears non-payment). A total refund withdraws the membership or frees the seat, except a Cercle top-up, never reversed automatically (the manager is told); the statement is Canari's own records only, no `transaction/list`.

**No re-enrolment is planned (owner, 2026-11-19: *"On oublie tout ça"*).** Read in production the same day: five associations are linked to Lydia, all recorded in `lydia_enrolled_businesses`; two still carry a `historical` bridge, and Les Rootz has no Lydia account at all, so the 2026-10-31 item "Le Cercle and Les Rootz re-enrolled with the owner" is dropped ([decisions](owner-decisions-of-2026-11-19.md)).
