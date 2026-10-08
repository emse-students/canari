### Fixed - the read-receipt popover says "Lu par Jolan", not "Lu par Jolan BOUDIN"

A person whose name was seeded without a first name never got one; the profile is now fetched once for it, and the cache redraws the popover. See [architecture](docs/wiki/frontend/architecture.md#the-first-name-has-its-own-cache-and-every-door-that-knows-it-must-fill-it-2026-10-09).
