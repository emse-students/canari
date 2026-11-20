## P2 - a Lydia cashier add binds the person and not the number, and overwrites a number Lydia already knows

target: 1.7.2

_2026-11-20: moved to 1.7.2 when 1.7.1 shipped._

Found by the adversarial review of the 1.7.1 flip of the cashier gate
([payments](../frontend/modules/payments.md#the-cashiers-enrolment-lot-3)). No direct exploit: every
add, role change and number change is authorised (`MANAGE_PAYOUT_ACCOUNT` on the URL's association),
claimed under one lock, and confirmed only by an exact `business/getpermission` read-back. What the
gate kept dark is that, until 1.7.1, no Tresorier or Vendeur could exist. Its first finding - a member
who leaves kept the row and Lydia's rights - is BUILT with the flip
([payments](../frontend/modules/payments.md#the-cashiers-enrolment-lot-3), "A membership that ends").

1. **The member check names the person, not the number.** A payout manager picks a member and
   types any number; the cashier notice (`LYDIA_CASHIER_NOTIFICATIONS_ENABLED`) is off until its floor,
   so the member whose name is used is not told - Lydia's SMS goes to the number. The audit line names
   the member and the manager. Flipping the notice (its floor, [legacy-compatibility](../legacy-compatibility.md))
   closes it; until then membership is a label on the row.
2. **An add never reads the number first.** `business/addcashier` REPLACES the rights of a number Lydia
   already lists (a co-manager added in the Lydia console, unknown to Canari): adding it as Vendeur
   would leave it `access_collect` only, recorded CONFIRMED. The fix is a `getpermission` read before
   an add, refusing a number that holds any right with a typed 409 - **blocked on a control
   measurement**. Measured on dev against homologation (2026-11-18, read-only): `getpermission` for
   two never-added numbers answers HTTP 200 `{"status":"error","code":"1","message":"Parametre
   manquant"}` - not `error: "0"` with every right at 0, so the fail-closed parser would refuse every
   add. Whether a KNOWN number on the same Business answers differently could not be measured: the dev
   estate holds no cashier row. Owed: the same read for a number Lydia lists on that Business (add a
   fictional number on homologation, read, remove); the read-before-add then treats exactly the
   never-added answer as "unknown to Lydia" and anything else unreadable as a refusal.
3. **An add whose record is refused after Lydia answered** (`LYDIA_CASHIER_CLAIM_LOST`,
   `LYDIA_BUSINESS_CHANGED`, a lost race on the one-live-row index) leaves rights at Lydia with no row
   and no "Retirer"; logged at ERROR. Recovery: re-add the same member and number (the add replaces,
   the record then exists), then remove.
4. **An account erasure deletes the row even when Lydia did not confirm the removal.**
   `revokeBeforeErasure` asks core for each number and logs an unconfirmed one at ERROR, but the
   erasure then deletes the person's rows, so the card cannot show the flag and no trigger asks again.
   Keeping the row needs a decision the code cannot take: the unique index
   `lydia_cashiers_one_live_member` forbids a placeholder `userId`, so the row would need a nullable
   `userId` (a migration) and the erasure would keep a sealed phone of an erased person until the
   removal is confirmed - a retention question for the register. Found by the second review of the
   flip (2026-11-18).
5. **No report names a departure debt nobody opens.** The debt is paid on a departure, on a card read
   and on a claim release; an association whose managers never open the payments card after a failed
   removal keeps a flagged row only its ERROR line names. A report (a daily count of flagged and
   departed rows per association, on the platform admins' existing report) would close it.
6. **The delete and unlink refusal has no way out when Lydia can never confirm.** A Business closed
   or blocked at Lydia, a revoked key, a seal that no longer opens, or an erased Responsable (no
   Responsable left: every removal is `LYDIA_CASHIER_NO_RESPONSABLE`) keeps the owed rows live and
   flagged, so `LYDIA_CASHIERS_LIVE` refuses both forever. Recommended (third review, 2026-11-18): a
   global admin proceeds past it when every owed number is already flagged NOT confirmed - the
   durable proof the verified path was tried - with one `[AUDIT]` ERROR per number left at Lydia.
7. **A departed Responsable has no in-app successor.** The card says "a new Responsable is needed,
   contact a platform administrator", but a platform administrator cannot set another person as
   Responsable on the same Business (`LYDIA_RESPONSABLE_ALREADY_SET`). Either an admin "replace the
   Responsable" step (add the new holder, then remove the old number through the verified path), or
   refusing a Responsable's own departure while their number is live. **Decided by the owner,
   2026-11-19: the departure is REFUSED while the person is Responsable** - *"il doit d'abord passer
   la main lui-même. C'est pour ça qu'il est important de pouvoir gérer les caissiers sur Canari"*: the
   Responsable hands over to another member through the cashier screens first (that hand-over step is
   owed if the screens cannot do it yet), and only then may leave ([decisions](owner-decisions-of-2026-11-19.md)).
   **Built 2026-11-20, behind its own switch, OFF**: "Transférer le rôle", the hand-over (add the heir
   with the 13 rights, record, remove the old number through the verified removal) and the departure
   refusal `LYDIA_RESPONSABLE_MUST_HAND_OVER`
   ([payments](../frontend/modules/payments.md#handing-the-responsable-over-owner-2026-11-19)); it flips
   after [homologation](reading-owed-the-lydia-responsable-hand-over-runs-against-homologation.md) and
   [the owner's trial](reading-owed-the-owner-hands-the-lydia-responsable-over-in-production.md).
8. **The claim fence is a clock.** social waits 30 s for core's removal and then records it NOT
   confirmed and releases the claim; core bounds its three Lydia calls to 24 s, but an axios timeout is
   per socket idle, not a total deadline. A late `removecashier` landing after a re-add of the same
   number would leave Lydia at 0 rights with the row confirmed - access lost, never gained. The fix is
   a fence at core (the claim token re-checked with social before `removecashier`), or keeping the
   claim on an unanswered removal as an unknown add does.

The second review (2026-11-18) also asked, and 1.7.1 does: a departure re-checks membership under its
claim, a busy claim is paid at its release, a refused or unanswered removal is flagged on the card,
core's removal answers within social's wait, and the delete and the unlink are refused while a number
is owed or a cashier step is in flight ([payments](../frontend/modules/payments.md#the-cashiers-enrolment-lot-3)).

Also done in 1.7.1 from the same review: a French number keeping its trunk 0 (`+330...`) is refused by
every server check and rewritten by the client, so one line has one spelling for the one-number-one-row
check; the unconfirmed-cashier wording says "remove it, then add it again" instead of a retry that does
not exist.
