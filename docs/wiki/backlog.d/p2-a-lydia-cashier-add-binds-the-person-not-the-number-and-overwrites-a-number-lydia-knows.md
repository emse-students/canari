## P2 - a Lydia cashier add binds the person and not the number, and overwrites a number Lydia already knows

target: 1.7.1

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

Also done in 1.7.1 from the same review: a French number keeping its trunk 0 (`+330...`) is refused by
every server check and rewritten by the client, so one line has one spelling for the one-number-one-row
check; the unconfirmed-cashier wording says "remove it, then add it again" instead of a retry that does
not exist.
