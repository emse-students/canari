### Added - "Modifier la réservation": a coming booking's time and other people can be edited

`PATCH /bookings/:id` replaces the range (same day, same room) and the companions in one transaction under the booking's locks, or refuses with a typed `BOOKING_EDIT_*` code and leaves the booking exactly as it was - an edit built on a view the booking has since left behind included (`stale`); the people added, removed or moved are notified and every reminder follows the new time ([bookings](docs/wiki/bookings-chantier.md#editing-a-booking-owner-2026-11-02)).
