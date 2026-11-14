## P3 - Post-stable proposal for the user: a partial unique index on tier keys (2026-10-26)

target: 1.9.0

A tier key derived from its label is kept unique by an association-level advisory lock around the
sibling read and the insert ([cotisations](../cotisations.md#a-new-tiers-key-is-derived-from-its-label-server-2026-10-26)).
Nothing in the schema enforces it: an explicit key from an older client still goes through a
read-then-insert check without that lock. Proposed for after the 1.5.0 stable, needing the user's
yes because it is a migration: a partial unique index on `(associationId, variantKey)` for
`membership` products (plus one for the base tier's null key), after counting the duplicates it
would refuse.

**The read-only count is written (batch 14, 2026-11-12):** `tools/read-only-sql/membership-tier-key-duplicates.sql` lists every (association, tier key) held by more than one membership product, base tier included, and the total the index would refuse. Not run here: the lead runs it on dev, then on production with the owner. The migration is drafted only once the count is known (0: as proposed; otherwise the duplicates are settled first).
