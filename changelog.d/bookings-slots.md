### Added - bookings slot generation (WP-B2)

Slots are generated on demand from each resource's availability in the space's zone, daylight-saving changes included. A window crosses at most one midnight. The booking window, the quotas, the participants' withdrawal delay (migration 088, as the user decided) and the D29 refusal are pure rules ([bookings](docs/wiki/bookings-chantier.md#wp-b2-as-built-2026-10-17)). CI's boot probe now runs production's PostgreSQL, pinned by digest.
