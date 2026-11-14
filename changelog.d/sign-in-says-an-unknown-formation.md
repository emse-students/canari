### Fixed - a formation Canari does not know is said at sign-in, and a profile that loses its spaces is logged

A cursus entry naming a formation no space carries left the person with no space and nothing said;
it is still kept - it is what tells a student from staff - and now logged `[UNKNOWN_FORMATION]`
(owner, 2026-11-14). A sign-in that takes away the campus or the whole cursus logs
`[OIDC_PROFILE_SHRANK]` ([profiles-and-access](docs/wiki/profiles-and-access.md)).
