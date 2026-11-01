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
