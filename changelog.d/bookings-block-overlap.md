### Fixed - bookings: the same "Indisponible" is no longer written twice

The server refuses a block that overlaps a block of the same resource (`block-overlap`), so a retry after a lost answer is idempotent; the sheet says the range is already unavailable ([bookings-chantier](docs/wiki/bookings-chantier.md#wp-b3-as-built-2026-10-17)).
