## P3 - clearing an association's cotisation mode leaves its members-only products and cards offered to nobody

Since 2026-11-01 a product or a partnership card cannot be SAVED as `membersOnly` by an association
with no `cotisationMode` (400 `MEMBERS_ONLY_WITHOUT_COTISATION`, `members-only-gate.ts`,
[cotisations](../cotisations.md#product-member-gating--pricing)). The reverse order is not covered:
an association that clears its mode (`AssociationsService.update`, `cotisationMode: null`) while such
rows exist keeps them as they are. `tierFactsOf` answers `null` without a mode, so `isBuyerCotisant`
is false for EVERYONE - including a buyer holding an unexpired tier tag of that association - and
those products and cards stay listed, greyed, and refused (`PRODUCT_COTISANTS_ONLY`,
`PARTNERSHIP_MEMBERS_ONLY`) to all. A product gated by `requiredTags` is not affected.

Deliberately unchanged by #2828 (review of 2026-11-01): the choice is the owner's - refuse the clear
with a typed 409 naming the rows until they are unticked, untick them in the same transaction, or
keep the present behaviour and say it on the cotisation settings screen.

**The gate that would lift it:** `associations.service.cotisation-mode-clear.spec.ts`, which clears
the mode of an association holding an ACTIVE members-only product and an active members-only card and
asserts the decided outcome (the typed refusal and nothing written, or both rows unticked in the same
commit), with a CONTROL association holding none whose clear succeeds untouched.

**Decided by the lead on 2026-11-12 (the owner's absence rule: reversible, so the recommended option
is taken and written here): the clear is REFUSED** with a typed `409 COTISATION_MODE_IN_USE` naming
the active members-only products and cards, and nothing is written; the settings screen says which
rows to untick (a Paraglide string). Unticking them silently would change what buyers see without
the association saying so; keeping today's behaviour leaves rows nobody can buy.

**The lock order the build owes, or the refusal is a race:** today the save's gate reads the mode
and the clear reads nothing, so a clear and a members-only save that overlap can both pass. Both
paths take the association row first, in their transaction: the clear `FOR UPDATE` before it counts
the rows, the product and card saves `FOR SHARE` before the gate reads the mode. The spec named above
gains the overlap case: a clear and a save racing on two connections, exactly one of them refused.
Not built in this pass.
