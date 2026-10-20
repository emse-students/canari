### Fixed - a repeated `u`/`sig` on a booking's `.ics` link is a 400, and a booking's answers keep only declared questions

The calendar route took a repeated query key as an array (a 500 on `sig`); a `__proto__` answer key became the prototype of the map a booking judged. Both are refused where they enter, the forms' rule now shared by both ([bookings](docs/wiki/bookings-chantier.md#wp-b5-as-built---the-bookers-api-2026-10-18)).
