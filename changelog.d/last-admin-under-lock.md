### Fixed - a community can no longer be left with members and no admin by concurrent writes

Departures, role changes, role edits and admissions now decide under the community removal lock,
in one lock order
([social-service](docs/wiki/services/social-service.md#a-community-always-has-an-admin-or-it-has-no-members-2026-08-18)).
