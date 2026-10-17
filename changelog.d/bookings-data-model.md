### Added - the bookings data model (WP-B1, migration 087)

Spaces, resources, availability, blocks, bookings and participants, with one live booking per resource and instant held by an EXCLUDE constraint (`btree_gist`); nothing reads them yet ([bookings](docs/wiki/bookings-chantier.md#wp-b1-as-built-2026-10-16)). An account erasure reaches every booking table through the shared `ERASURE_STATEMENTS` ([account-erasure](docs/wiki/account-erasure.md)).
