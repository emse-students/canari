## P2 - a Lydia cashier who leaves the association keeps Lydia's rights, and an add overwrites a number Lydia already knows

target: 1.7.1

Found by the adversarial review of the 1.7.1 flip of the cashier gate
([payments](../frontend/modules/payments.md#the-cashiers-enrolment-lot-3)). No direct exploit: every
add, role change and number change is authorised (`MANAGE_PAYOUT_ACCOUNT` on the URL's association),
claimed under one lock, and confirmed only by an exact `business/getpermission` read-back. What the
gate kept dark is that, until 1.7.1, no Tresorier or Vendeur could exist.

1. **A member who leaves, or is removed, keeps the cashier row and Lydia's rights.** `removeMember`
   (social-service `associations.service.ts`, which `leaveAssociation` goes through) never touches
   `lydia_cashiers`; only an account erasure removes numbers (`revokeBeforeErasure`). A Tresorier
   removed after a dispute keeps cancel and refund rights until a manager presses "Retirer", and the
   list does not say they left. Deleting an association has the same gap (logged at ERROR). Done in
   1.7.1: a role change re-checks membership (`LYDIA_CASHIER_NOT_A_MEMBER`, the claim released).
   **Owed:** the departure asks the removal through core (the erasure's route, scoped to that
   association, and the row closed by the record), or at least the list marks "no longer a member".
2. **The member check names the person, not the number.** A payout manager picks a member and
   types any number; the cashier notice (`LYDIA_CASHIER_NOTIFICATIONS_ENABLED`) is off until its floor,
   so the member whose name is used is not told - Lydia's SMS goes to the number. The audit line names
   the member and the manager. Flipping the notice (its floor, [legacy-compatibility](../legacy-compatibility.md))
   closes it; until then membership is a label on the row.
3. **An add never reads the number first.** `business/addcashier` REPLACES the rights of a number Lydia
   already lists (a co-manager added in the Lydia console, unknown to Canari): adding it as Vendeur
   would leave it `access_collect` only, recorded CONFIRMED. The fix is a `getpermission` read before
   an add, refusing a number that holds any right with a typed 409 - **blocked on one homologation
   measurement**: what `getpermission` answers for a number never added (if it is an error, the read
   cannot tell "unknown" from "unreadable" and would refuse every add).
4. **An add whose record is refused after Lydia answered** (`LYDIA_CASHIER_CLAIM_LOST`,
   `LYDIA_BUSINESS_CHANGED`, a lost race on the one-live-row index) leaves rights at Lydia with no row
   and no "Retirer"; logged at ERROR. Recovery: re-add the same member and number (the add replaces,
   the record then exists), then remove.

Also done in 1.7.1 from the same review: a French number keeping its trunk 0 (`+330...`) is refused by
every server check and rewritten by the client, so one line has one spelling for the one-number-one-row
check; the unconfirmed-cashier wording says "remove it, then add it again" instead of a retry that does
not exist.
