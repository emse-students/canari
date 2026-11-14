## P3 - drop `association_categories` and `associations.categoryId`, left in the schema by migration 147

target: 1.10.0

Migration 147 (2026-11-08) replaced the global category by each map's own zones and switches
([carte](../carte-vie-asso.md#1-zones-per-map---the-global-category-is-gone)); the code stopped
reading and writing the table and the column, but the schema keeps them so a server rolled back to
the previous release still boots, and a build older than 147 still gets `[]` from the GET shim
([legacy-compatibility](../legacy-compatibility.md)).

**Owed:** one held migration dropping the FK, the column and the table, once the oldest release
production may roll back to no longer maps them (the precedent is migration 134), together with the
GET shim's removal, and `association_categories` taken out of `RAW_TABLES` in
`account-erasure.coverage.spec.ts` (listed there only because the table outlives its entity). The
dev seed already writes neither.
