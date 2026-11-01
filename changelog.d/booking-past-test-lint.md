### Fixed - a lint warning in a bookings grid test

The test unmounted the first grid with `app && unmount(...)` as an expression; it is now an `if`, no behaviour change
([bookings-chantier](docs/wiki/bookings-chantier.md#the-phones-planning-d55-2026-11-01-owner)).
