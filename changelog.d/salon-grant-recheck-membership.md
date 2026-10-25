### Fixed - a salon grant racing a kick no longer leaves the kicked member on the allowlist

An access-list rewrite now checks, under the community removal lock, that everyone it adds is still a member, and refuses `409 CHANNEL_GRANTEE_NOT_MEMBER` otherwise ([social-service](docs/wiki/services/social-service.md#every-writer-that-adds-to-an-allowlist-asks-membership-under-a-lock-a-kick-also-takes-2026-10-25)).
