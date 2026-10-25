### Fixed - RM-4 races the request the panel really sends, and RM-4b is the revoke race

RM-4 held an access PATCH for a revoke the panel sends as `DELETE /members/:userId`. RM-4 now races two grants, and RM-4b races two revokes. Finding this exposed a P2: a rewrite from a stale access panel silently cuts whoever was granted since ([campaign](docs/wiki/cross-client-campaign-1-4-1.md), [backlog](docs/wiki/services/social-service.md#an-access-rewrite-names-the-revision-it-edited-2026-10-25)).
