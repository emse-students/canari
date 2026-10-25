### Fixed - two concurrent exits from a community's admin set can no longer leave it with no admin

A demotion, a leave and a kick ask the last-admin check again under the community removal lock,
where they write; the one that would leave no admin is refused `409 WORKSPACE_WOULD_HAVE_NO_ADMIN`
([social-service](docs/wiki/services/social-service.md#a-community-always-has-an-admin-or-it-has-no-members-2026-08-18)).
