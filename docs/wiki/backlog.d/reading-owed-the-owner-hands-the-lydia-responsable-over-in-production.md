## Reading owed - the owner hands the Lydia Responsable over in production, then takes it back

target: 1.7.2

**What is built**: the hand-over of the Responsable, OFF behind `LYDIA_RESPONSABLE_HANDOVER_ENABLED`
([payments](../frontend/modules/payments.md#handing-the-responsable-over-owner-2026-11-19)). Its flip
needs the [homologation run](reading-owed-the-lydia-responsable-hand-over-runs-against-homologation.md)
first, then this production trial by the owner on the stable that carries the switch ON (the same
shape as the cashier gate's trial, owner's decision of 2026-11-19, item 45). A real Business, real
numbers, so it is the owner's own hand and never the lead's.

**The reading that closes it** (the owner, on an association whose Business is linked and whose
Responsable he is, with a second member he trusts, who holds a phone and MANAGE_PAYOUT_ACCOUNT):
"Transférer le rôle" to that member, accept the confirmation, then have them hand it back the same way. Expected each time, in this
order: Lydia's SMS reaches the heir's phone; core's `responsable confirmed with exactly 13 right(s)`;
social's `[AUDIT] Lydia Responsable hand-over ... - handed-over`; the old number's `removal of phone
ending NN: confirmed, 0 rights`; the heir's bell row "Vous êtes désormais Responsable de ..." (on a build at
or above `1.7.3`); the card shows the heir as Responsable with no other number; the Lydia Pro app no
longer shows the Business on the old holder's phone. Nothing at WARN or ERROR.

If the removal of the old number reads `the re-read still shows N right(s)`, the hand-over stands and
the card flags that number: "Retirer cet autre numéro" asks again (safe to repeat). Write the reading
into [device-verification](../device-verification.md) and delete this file.
