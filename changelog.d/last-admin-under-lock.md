### Fixed - a community can no longer be left with members and no admin by concurrent writes

Every membership write that can shrink the admin set, every admission and a community's deletion
now decide under the community removal lock, in one lock order
([social-service](docs/wiki/services/social-service.md#a-community-always-has-an-admin-or-it-has-no-members-2026-08-18)).
