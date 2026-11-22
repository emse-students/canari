## Reading owed - the "you were added as a Lydia cashier" notice (switched on 2026-11-20)

target: 1.8.0

_2026-11-22: moved to 1.8.0 when 1.7.3 shipped._

_2026-11-20: moved to 1.7.3 when 1.7.2 shipped._

**What is built:** the bell row telling a member they were added as a cashier of an association's Lydia Business (`lydia_cashier_added`, Lydia enrolment lot 3, #2798, `v1.6.0`; no push). `LYDIA_CASHIER_NOTIFICATIONS_ENABLED` is `true` since 2026-11-20: the floor reads `1.7.0` on both estates, above `v1.6.0`, and the owner decided on 2026-11-18 to flip it with the floor. The constant stays as the kill switch. It also closes the first finding of the [cashier-add entry](p2-a-lydia-cashier-add-binds-the-person-not-the-number-and-overwrites-a-number-lydia-knows.md): the member whose name is used is now told in the app.

**The reading that closes it:** on the Mi 9T AND the iPhone 12, a payout manager of a dev association (Lydia homologation) adds the other phone's account as Vendeur: that account gets ONE bell row naming the association, drawn in its language, which opens the Lydia Pro help page; no push, and no row for a role change or a removal.
