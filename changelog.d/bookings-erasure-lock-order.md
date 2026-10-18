### Fixed - an account erasure could deadlock a booking on its linked resource

The bookings part of the erasure now takes spaces, then resources, then bookings, like the booking path; a stray deadlock answers `try-again`, and a block starting a few seconds before the server's now starts at now instead of being refused ([bookings](docs/wiki/bookings-chantier.md#a-deleted-account-2026-10-16-review-of-1963)).
