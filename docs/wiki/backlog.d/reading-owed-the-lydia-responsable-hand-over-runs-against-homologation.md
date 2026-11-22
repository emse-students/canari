## Reading owed - the Lydia Responsable hand-over runs against homologation

target: 1.8.0

_2026-11-22: moved to 1.8.0 when 1.7.3 shipped._

_2026-11-20: moved to 1.7.3 when 1.7.2 shipped._

**What is built** (2026-11-20, owner's decision of 2026-11-19, item 31): "Transférer le rôle" in the
cashier section hands the Responsable to another member - add the heir's number with the 13 rights and
read them back, record, then remove the old number through the verified removal
([payments](../frontend/modules/payments.md#handing-the-responsable-over-owner-2026-11-19)). It ships
behind `LYDIA_RESPONSABLE_HANDOVER_ENABLED`, OFF, because it has never run against Lydia: the specs mock
Lydia and the PostgreSQL ones run the real SQL, but no call has reached the sandbox.

**The reading that closes it**, on dev (which addresses `homologation.lydia-app.com` only, no money moves),
with a build whose four switches are ON (the flip's pull request, cut as a pre-release): on a test
association whose sandbox Business is linked and whose Responsable is confirmed, hand the role to
another test member who holds MANAGE_PAYOUT_ACCOUNT, with a fictional number, then read core's and
social's logs, numbers only by their last two digits:

1. core `Lydia Responsable of <id>: hand-over claimed, adding the new holder`, then
   `[LYDIA-CASHIER] association <id>: adding a responsable (phone ending NN, 13 right(s))` and
   `responsable confirmed with exactly 13 right(s)`;
2. social `[AUDIT] Lydia Responsable hand-over on association <id>: to user <8>, phone ending NN, by <8>
   - handed-over; the old number is removed next`;
3. the removal: core `removal of a previous number asked`, the re-read `removal of phone ending MM:
   confirmed, 0 rights`, social `[AUDIT] Lydia cashier removal ... (previous number) ... - confirmed by
   Lydia (0 rights)`, then core `handed over; the old number removed (0 rights)`;
4. social `[LYDIA-NOTIFY] association <id>: Responsable <8> told (1 row)`; on a build at or above the
   notice's floor (`1.7.3`), the heir's bell reads "Vous êtes désormais Responsable de ..." (a `1.7.2`
   pre-release is below the floor and never receives it - expected);
5. the card lists the heir as Responsable and no other number; the old holder may now "Quitter" the
   association, the heir may not (`LYDIA_RESPONSABLE_MUST_HAND_OVER`).

Nothing at WARN or ERROR on that path. Then hand it back to a member who is a Tresorier, with THEIR
number: promoted in one step, their Tresorier row gone, the card listing them as Responsable. Then two
failures on purpose: a member without MANAGE_PAYOUT_ACCOUNT is not in the picker (and the route refuses
`LYDIA_RESPONSABLE_HANDOVER_HEIR_NOT_PAYOUT_MANAGER`, nothing claimed); a platform admin removing the
Responsable from the roster is asked to type the association's name, and the removal says at ERROR that
the number keeps its rights. Write the reading into
[device-verification](../device-verification.md) and delete this file.

**2026-11-22: UNREAD.** `LYDIA_RESPONSABLE_HANDOVER_ENABLED` is `false` on main and on dev `1.7.3-alpha.5`; the flip's pull request is not merged, so no call can reach the sandbox.
