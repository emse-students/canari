## P2 - the audience audit of 2026-11-14: what the campus x formation model still leaves open

target: 1.8.4

A read-only audit of every surface that serves content against the one statement of who sees what (`apps/social-service/src/spaces/reader-spaces.ts`, [profiles-and-access](../profiles-and-access.md), [reform](../spaces-and-audiences-reform.md)). The sound surfaces and the owner's closed answers are in [the record](../decisions/audience-audit-2026-11-14.md); what remains:

- **D32 - two cursus pay the most favourable price.** Prices, question visibility and the right to submit read the FIRST cursus only (`legacyColumns` in `core-service/src/users/miconnect-profile.ts` feeds `PricingFactsService.fetchProfile`; nothing in `forms/` or `pricing/` reads `users.cursus`). The directory's `formation` filter and `GET forms/criteria/formations` share the leftover.
- **The campus and formation admin (G5, WP-D1b) is not built.** Adding a formation or a campus means changing together `SPACE_FORMATIONS` / `SPACE_CAMPUSES`, the CHECK constraints of migrations 071 and 078, `FORMATIONS` / `CAMPUSES` in core-service and the frontend, the enrolment blueprint, the audience grid and the agenda filter.
- **A nickname report reaches no BDE moderator** (`reportInBdeScopeSql` has no branch for it): the platform admin alone sees it.
- **A profile correction does not drop the feed cache** (30 s); a follow that begins or ends already drops its reader's pages.
- Staff accounts have no space of their own by campus; that is decided (a nominative read grant is the door), not open.
