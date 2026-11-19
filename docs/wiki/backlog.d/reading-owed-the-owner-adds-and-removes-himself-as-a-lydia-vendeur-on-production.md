## Reading owed - the owner adds himself as a Lydia Vendeur of an association, then removes himself (production, 1.7.1)

target: 1.7.1

**What is built.** Adding a Tresorier or a Vendeur, changing a cashier's role and changing the
Responsable's number are ON since 1.7.1 (`LYDIA_CASHIER_ADD_ENABLED` and its two twins; owner,
2026-11-18). Removal re-reads `business/getpermission` for the removed number and counts ONLY "no
`access_*` at `"1"`" as a removal; anything else is an ERROR and the row stays live, flagged
([payments](../frontend/modules/payments.md#the-cashiers-enrolment-lot-3)). The removal path was
measured on Lydia homologation on 2026-10-30; it has never run in production, because no production
association held a removable cashier while adding was off.

**The reading that closes it** (the owner, once 1.7.1 is the production stable): on an association
whose Lydia Business is linked and whose Responsable is confirmed, add himself as **Vendeur** from
"Caissiers", then press "Retirer" on that row. Expected, in this order, with the phone only as its last
two digits:

1. the add: core `[LYDIA-CASHIER] association <id>: adding a vendeur (phone ending NN, 1 right(s))`,
   then `vendeur confirmed with exactly 1 right(s)`, then social `[AUDIT] Lydia cashier added on
   association <id>: ...`; Lydia's SMS reaches the phone, and nothing at WARN or ERROR (the cashier
   bell row is switched off until its floor and says so at DEBUG);
2. the removal: core `removal of phone ending NN asked`, then the re-read's verdict
   `removal of phone ending NN: confirmed, 0 rights`, then `Lydia cashiers of <id>: removal of a
   current number confirmed`, then social `[AUDIT] Lydia cashier removal ... - confirmed by Lydia (0
   rights)`; the row leaves the list, and the Lydia Pro app no longer shows the Business on that phone.

A WARN `Lydia did not accept the call (...) - the re-read decides` alone is not a failure; an ERROR
`the re-read still shows N right(s)` or `the re-read failed` is, and the row then stays live with its
"Retirer" offered again (repeating a removal is safe). Write the reading into
[device-verification](../device-verification.md) and delete this file.
