### Added - the bookings API (WP-B3)

`/api/bookings` books, cancels, withdraws, blocks and reads a space. Every colliding write locks the space then the resource, so a lost race is a typed `slot-taken` and quotas hold across resources ([bookings](docs/wiki/bookings-chantier.md#wp-b3-as-built-2026-10-17)).
