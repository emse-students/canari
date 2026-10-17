### Added - bookings slot generation (WP-B2)

Slots are generated on demand from each resource's availability in the space's zone, daylight-saving changes included, with the booking window, quotas, withdrawal delay and the D29 refusal as pure rules ([bookings](docs/wiki/bookings-chantier.md#wp-b2-as-built-2026-10-17)). CI's boot probe now runs production's PostgreSQL by digest.
