### Fixed - a formation Canari does not know is dropped at sign-in, and a profile that loses its spaces is logged

A cursus entry naming a formation no space carries (`Master`, `icm`) was stored as received, leaving
the person with no space and nothing said; it is now dropped with a warning, like an unknown campus
(owner, 2026-11-14). A sign-in that takes away the campus or the whole cursus logs
`[OIDC_PROFILE_SHRANK]` ([profiles-and-access](docs/wiki/profiles-and-access.md)).
