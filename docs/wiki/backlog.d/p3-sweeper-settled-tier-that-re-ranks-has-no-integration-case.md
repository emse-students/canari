## P3 - no integration case for a sweeper-settled tier that re-ranks to `paid_not_granted`

`lydia-reconciliation.integration.spec.ts` settles a checkout the callback never confirmed, but never
one whose tier is no longer a rise when the sweep settles it. **Found 2026-11-01 when trying it:** the
spec builds `ProductsService` with `Object.create(prototype)` and only the repos the existing cases
touch (no `UserTagService`, no `associations` columns beyond the two the key test reads), so a
settlement that ranks a tier needs the real `UserTagService`, the association's `cotisationMode` and
slug columns, a membership `association_products` row and a held `user_tags` row in the throwaway
schema. That is a harness extension (a second fixture family), not a case: build it once, then the
case is "hold the dearer tier, let the sweep settle a checkout of the cheaper one, expect a
`paid_not_granted` record and no tag swap". Mechanism: [cotisations](../cotisations.md).
