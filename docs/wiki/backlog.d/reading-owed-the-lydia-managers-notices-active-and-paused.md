## Reading owed - the Lydia managers' notices, "payments active" and "payments paused" (switched on 2026-11-20)

target: 1.8.0

_2026-11-22: moved to 1.8.0 when 1.7.3 shipped._

_2026-11-20: moved to 1.7.3 when 1.7.2 shipped._

**What is built:** the bell row and the push telling an association's `MANAGE_PAYOUT_ACCOUNT` holders that its Lydia payments became active (`lydia_payments_active`) or were paused (`lydia_payments_paused`), Lydia enrolment lot 2 (#2780, `v1.5.3`). `LYDIA_PAYMENTS_NOTIFICATIONS_ENABLED` is `true` since 2026-11-20: the floor reads `1.7.0` on both estates, above `v1.5.3`, and the owner decided on 2026-11-18 to flip the managers' notices together with that floor. The constant stays as the kill switch ([payments](../frontend/modules/payments.md), [legacy-compatibility](../legacy-compatibility.md)).

**The reading that closes it:** on the Mi 9T AND the iPhone 12, signed in as a payout manager of a dev association, cause one transition (an admin validation of its Lydia Business, then a refused payment request for the pause): the push arrives with the French-or-English sentence naming the association (not a generic banner), and the bell row reads "payments active" or "payments paused", not the neutral "cannot show" row; a tap opens the notifications list. The transition line in the dev logs reads `managers told next`, not `notices off by switch`.
