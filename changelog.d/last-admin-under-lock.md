### Fixed - a community can no longer be left with members and no admin by concurrent writes

Every write that can shrink the admin set (leave, kick, demotion, a revoke of `workspace.manage` on a
role, an erasure's departure) and every admission re-checks under the community removal lock
([social-service](docs/wiki/services/social-service.md#a-community-always-has-an-admin-or-it-has-no-members-2026-08-18)).
