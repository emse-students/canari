# The platform's Lydia contract: its terms, its flux counter, the payout estimate

**Decided by the owner on 2026-11-14.** The platform signed a partnership with Lydia that runs by
contract year and commits it to a minimum yearly FLUX of payments; below it, Lydia regularizes the
year's rates by volume band. The owner: *"Tout dans reglages admin, marges comprises. Ce sont des
reglages plateforme."*

**THE CONTRACT IS CONFIDENTIAL AND THIS REPOSITORY IS PUBLIC.** No contract value - the target, the
rates, the bands, the VAT rate - appears in code, tests, this wiki, a changelog, a commit or a pull
request. Every value is entered by a global admin at `/admin/platform` and lives in the database
only. The tests use obviously made-up numbers. No value is seeded, the anniversary included (owner,
2026-11-14): core migration 024 adds the columns, NULL until an admin enters them.

## The terms, and where they live

ONE place: the `platform_config` singleton row of core-service (migration 024), beside the other
platform switches - but never part of `PlatformConfigPublic`, which `GET /api/version` publishes.

| Column | Holds | Unset means |
| --- | --- | --- |
| `lydia_contract_anniversary` (`DATE`) | the date every contract year starts on | no counter |
| `lydia_contract` (`JSONB`) | `fluxTargetCents` (TTC), `vatBps`, `fees` by payment kind, `bands` | each value "not configured" |

`fees` and each band's `fees` are keyed by payment kind (`LYDIA_PAYMENT_KINDS`,
`apps/core-service/src/platform/lydia-contract.ts`): `remote` (a request Canari issues: the boutique
and paid forms), `qr` and `tap_to_pay` (collected face to face in Lydia's own app by the cashiers
Canari adds). Each fee is `{ percentBps, fixedCents }`, **HT as the contract states it**; `vatBps`
turns it into what is really deducted. A band is `{ fromCents, fees }`, ascending.

**Every write is parsed whole and refused by field** (`parseLydiaContractTerms`; `PUT
/api/users/admin/platform/lydia-contract`, a 400 `LYDIA_CONTRACT_INVALID` naming the field, nothing
written): a typo in a confidential rate is caught at the write or nowhere. A stored value that no
longer parses (a hand edit) is read as not configured and logged at ERROR. The write is logged at
WARN with the actor and WHICH values are set, never a value.

**A copy of production carries no terms.** `copy-strips.sh` clears `lydia_contract` and the anniversary,
and empties `lydia_enrolled_businesses` with the other live Lydia identifiers, so dev's counter
and estimate say "not configured" until someone enters made-up values there.

**No default for any value, the anniversary included.** A value not entered is said to be not configured -
by the counter (`missing`), by the payout estimate - and the server logs it at WARN each time an
estimate or a counter is asked without it: a fallback is a signal, never a path.

## The payout estimate

`PayoutFeeHint.svelte` (the price screens of the boutique, of paid forms and of the Cercle top-up)
asks `GET /api/payments/lydia-fee-schedule` (core-service `LydiaFeeScheduleController`): the `remote`
fee and the VAT, or `{ schedule: null }`.

**Only a caller who may edit a price somewhere is answered** (owner, 2026-11-14: *"Reserver a ceux
qui gerent la boutique, les formulaires etc ? Enfin tous ceux qui en ont besoin"*); anyone else gets
a 403 `LYDIA_FEES_NOT_A_PRICE_EDITOR`, and a check that cannot be made a 502, never an answer. The
predicate is social-service's ONE `AssociationsService.mayEditAPrice`, built from the rights that
guard the editors and asked by core through `GET internal/payments/may-edit-a-price`: a global admin;
a BDE super-admin; a member holding `MANAGE_PRODUCTS` or `MANAGE_FORMS` in an association or a list
(not an institution, which collects nothing). A form's creator is not one by being its creator: an
association's form is managed by `MANAGE_FORMS` alone, and a personal form is offered no price and no
estimate (owner, 2026-11-14, [forms](frontend/modules/forms.md#who-manages-an-associations-forms-owner-2026-11-14)).
The client asks once per reader (`fetchLydiaFeeSchedule`, a `SharedCache` holding the schedule, "not
configured" and the refusal alike; an admin's save drops it), so the WARN of an unconfigured
schedule is one per session, not one per estimate mounted.

The fee really deducted from a payment is

    fee = round((fixedCents + gross * percentBps / 10000) * (1 + vatBps / 10000))

rounded once to the cent (`computeLydiaFeeCents`, `frontend/src/lib/payments/lydiaFees.ts`), and the
net is `gross - fee` - exact for the entered schedule, so nothing is worded as approximate.

**What each side sees** (owner, 2026-11-14: *"Le client doit toujours voir le montant qu'il paye, et
l'association doit voir le montant paye et en plus petit le montant net."*): the PAYER sees only the
price they pay - no fee, no net, anywhere; the EDITOR sees each price paid and, smaller beneath it,
the net for the association, then the one short notice: the provider's fees are deducted from each
payment, and the rate may be raised at the end of the contract year if the target is not reached.
While no schedule is entered the hint says the net is unavailable, never a figure.

Until 2026-11-14 the estimate was a constant in `lydiaFees.ts`, HT, so it under-estimated the fee
by the VAT.

## The flux counter

On `/admin/platform` (`LydiaContractPanel.svelte`, `GET .../lydia-contract/counter`): the current
contract year `[anniversary, next anniversary)`, its flux against the target with a progress bar, the
days left, and the band the flux falls in with the next one up - the regularization risk at a
glance.

**Which association the total comes from** (owner, 2026-11-14: *"L'admin devrait aussi voir, si
possible, quel montant sur le total vient de quelle association"*): under the total, one row per
association - a list has its own row - with its payments, its refunds, its net flux and its share of
the total, sorted by flux descending, and what of its payments is NOT counted and why (on a Business
Canari did not enrol, a historical account; or with no identifiable Business). A payment belongs to
the association its record was written for (`purchase_records."associationId"`), a refund to its
`lydia_refunds."associationId"`. `measureLydiaFlux` measures BY association and the totals are the
SUMS of those rows - one query, one definition of the flux, asserted by both specs.

**The contract year** is the one the anniversary puts today in, in Paris (`contractYearOf`,
`parisDate`): from the last anniversary on or before today to the next one. A 29 February
anniversary falls on the 28th in a common year. Before the first anniversary there is no year.

**The flux** is measured by social-service (`measureLydiaFlux`,
`apps/social-service/src/associations/lydia-contract-flux.ts`, `GET internal/payments/lydia-flux`):
the payments Lydia confirmed within the year, MINUS the refunds Lydia executed within the year, TTC,
across every association, **on the Businesses Canari's enrolment created only**. The window's bounds
are Paris midnights.

- **A payment** is a `purchase_records` row, `paymentMethod = 'online'`, status `paid`,
  `paid_not_granted` or `refunded` (refunded since: the money WAS collected, and the refund is
  counted on its own date), dated by `paidAt` - the record is written when Lydia's confirmation is
  settled.
- **A refund** is a `lydia_refunds` row Lydia executed - `confirmed`, or `pending` with Lydia's own
  `refunded-unrecorded` answer - dated by Lydia's answer, else the manager's declaration after
  checking Lydia (the date the association's statement prints).
- **Why a refund counts in the year it is executed, not the payment's year.** The contract counts the
  volume of transactions in the contract year, and a refund is a transaction of the day it happens.
  A payment of one year refunded in the next therefore counts in full in the first and reduces the
  second. Deciding the other way would rewrite a closed year after its regularization.

### Enrolled or historical: the discriminator

Payments collected on an association's HISTORICAL account (one it held with Lydia before Canari's
enrolment, collecting through a [bridge](frontend/modules/payments.md#a-historical-account-collects-until-the-enrolled-business-is-validated-owner-2026-11-13))
belong to that association's own earlier contract with Lydia, never to this partnership. Two durable
facts decide it, neither a date nor an association's current columns (a bridge swaps them, an unlink
clears them):

1. **Which Business took the payment** is the purchase record's own `"lydiaVendorToken"` (social
   migration 169), written with the record at the settlement - the paid attempt's token for a
   boutique purchase, the answer's for a form payment - so a payment keeps its Business when its
   answer is deleted or its form retired (owner, 2026-11-14: *"Ca doit aussi survivre a la
   suppression d'un formulaire."*). Migration 169 backfilled every earlier record from the same
   trace. A record without it (written by an older image during a rollout) is read through the row
   that issued it - `product_checkouts."vendorToken"`, `submissions."lydiaVendorToken"`, the trace a
   refund follows ([refunds](frontend/modules/payments.md#refunds-from-canari-enrolment-lot-4)) -
   and counted at WARN as `recordWithoutToken`. Nothing deletes a record: no foreign key reaches it,
   a form is only soft-deleted (`retireForms`; `submissions_form_fk` is `RESTRICT`), and **a paid
   answer is never deleted** - `FormsService.deleteSubmission` refuses `paid` and `paid_over_capacity`
   in the DELETE's own WHERE with a typed 409 `FORM_ANSWER_PAID` (`libs/contracts/form-answers.json`),
   and the manager is told to refund or cancel it instead. A `pending` answer is cancelled first
   (`cancelSubmission`: its request settled at Lydia), so no payment lands on a deleted answer.
2. **Whether Canari's enrolment created that Business** is `lydia_enrolled_businesses` (social
   migration 168), written by `AssociationsService.setLydiaAccountId` in the transaction that links
   the Business - the ONE link path, called only by core-service's onboarding right after
   `business/create` (the paste route is retired). The pending Business of a bridge is recorded the
   same way. A row is never deleted: an unlinked or switched-away Business stays enrolled, so the
   payments it took keep counting in their year.

A payment counts when its Business is in the ledger AND no bridge holds it as a historical account
(`historicalVendorToken`, migration 167) - the bridge's own fact wins, so a historical account never
counts even if a ledger row names it by mistake; such a contradiction is logged at ERROR. A payment
on any other Business is reported as `excluded` (shown on the counter). A Lydia payment no row ties to
a Business (a form answer before migration 120, a boutique purchase before 101) is counted nowhere
and logged at ERROR as `untraceable`.

**The backfill (migration 168, HELD for the owner).** Businesses linked before the ledger existed are
backfilled once, from an ALLOWLIST: an association's active `lydiaAccountId` only when it carries the
proof of `business/create` - its dashboard URL, which Lydia hands out in that answer alone and without
which the enrolment refuses to link (enrolment lot 1) - and never a bridge's historical account; plus
every bridge's enrolled Business. The first draft took every active `lydiaAccountId` except a bridge's
historical account, a denylist: migration 167 ships in the same release and its bridges are opened by
hand afterwards, so the denylist would have been EMPTY when it ran and every historical account still
collecting would have been counted. Measured read-only on 2026-11-14: production held 5 linked
associations, 2 of them historical accounts with no dashboard URL (and no bridge table yet); dev held
1, with no dashboard URL. With the proof, the backfill takes 3 on production and 0 on dev.

**Before approving its checksum**, the approver lists what the backfill would leave out - every linked
association without the proof - and checks each is a historical account:

```sql
SELECT a.id, a.name FROM associations a
 WHERE a."lydiaAccountId" IS NOT NULL AND a."lydiaDashboardUrl" IS NULL;
```

and what it would take, each of which must have enrolled through Canari (its cashier rows were added
by Canari under that Business):

```sql
SELECT a.id, a.name, (SELECT count(*) FROM lydia_cashiers c WHERE c."vendorToken" = a."lydiaAccountId")
       AS cashiers
  FROM associations a
 WHERE a."lydiaAccountId" IS NOT NULL AND a."lydiaDashboardUrl" IS NOT NULL;
```

A Business left out is reported as `excluded` on the counter, and a person who knows it was enrolled
adds it by hand (`INSERT INTO lydia_enrolled_businesses ("vendorToken", "associationId") VALUES (...)`).
A Business enrolled and unlinked before the migration is not recovered: no table names it.

**A Business put into a bridge BY HAND** (the second step of
[opening a bridge](frontend/modules/payments.md#a-historical-account-collects-until-the-enrolled-business-is-validated-owner-2026-11-13),
for a Business created before the bridge existed) does not pass through `setLydiaAccountId`, so the
same transaction inserts its ledger row; otherwise its payments are `excluded`.

### What the counter cannot see

**Only payments Canari issues are counted.** The cashiers Canari adds to a Business collect face to
face in Lydia's own app (`qr`, `tap_to_pay`), and those payments never reach Canari's rows; Lydia's
flux includes them. The counter says so under its figures. The face-to-face fees are entered anyway,
for the bands.

**`paidAt` is a `timestamp` without time zone** (TypeORM's `CreateDateColumn`), written with the
database session's clock and compared to the Paris-midnight bounds in that session's zone, as every
other read of it does.

## Where to look

| What | Where |
| --- | --- |
| The terms, the year, the band | `apps/core-service/src/platform/lydia-contract.ts`, `lydia-contract.service.ts` |
| The routes | `platform-admin.controller.ts` (`lydia-contract`, `lydia-contract/counter`), `lydia-fee-schedule.controller.ts` |
| The flux and the ledger | `apps/social-service/src/associations/lydia-contract-flux.ts`, migration 168 |
| The admin screen | `frontend/src/lib/components/admin/LydiaContractPanel.svelte`, `frontend/src/lib/admin/lydiaContract.ts` |
| The estimate | `frontend/src/lib/payments/lydiaFees.ts`, `PayoutFeeHint.svelte` |
| The proof against PostgreSQL | `lydia-contract-flux.integration.spec.ts` |
