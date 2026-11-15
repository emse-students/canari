## P2 - the audience audit of 2026-11-14: what the campus x formation model leaves open

target: 1.7.0

A read-only audit of every surface that serves content, against the one statement of who sees what
(`apps/social-service/src/spaces/reader-spaces.ts`,
[profiles-and-access](../profiles-and-access.md), [reform](../spaces-and-audiences-reform.md)).
**Sound, traced to the query:** the feed and its tabs, the search, a post by id, comments,
reactions, polls, mentions, pins, republications, member reposts, the bell's post-bound rows, lives
(list, key, manifest, withheld chat, pushes), nominative read grants, the write of an audience
(bounds G8 / D1), the internal routes, an account switch on one device. The findings that are a
weakness are tracked privately until fixed; one shipped with this entry (a scheduled post read
through its event's card). What is left, each a defect to fix or a decision already taken:

### Decided, not built

- **D32 - two cursus pay the most favourable price.** Prices, question visibility and the right to
  submit read the FIRST cursus only: `legacyColumns` (`core-service/src/users/miconnect-profile.ts`)
  feeds `PricingFactsService.fetchProfile`, and nothing in `forms/` or `pricing/` reads
  `users.cursus`. Same leftover: the directory's `formation` filter and `GET
  forms/criteria/formations` see the first cursus only.
- **Staff in the app.** A staff account (a campus, an empty cursus) has no space: the agenda shows
  it memberships and read grants only, in the app and through its subscription link alike
  ([owner, 2026-11-15](../profiles-and-access.md#a-staff-accounts-subscription-shows-its-in-app-agenda-owner-2026-11-15));
  the shop, the partnerships and the association directory are empty for it. NOT opened by campus (owner, 2026-11-14): the door is a
  nominative read grant, which now opens the directory, the shop and the partnerships of its cell
  beside the posts and the agenda
  ([as built](../profiles-and-access.md#a-grant-opens-everything-of-its-cell-owner-2026-11-14)).
- **The campus and formation admin (G5, WP-D1b)** is not built. Adding a formation or a campus today
  means changing together: `SPACE_FORMATIONS` / `SPACE_CAMPUSES`, the CHECK constraints of
  migrations 071 and 078, `FORMATIONS` / `CAMPUSES` in core-service and the frontend, the enrolment
  blueprint, the audience grid and the agenda filter.

### Dead zones and inconsistencies

- **A nickname report reaches no BDE moderator** (`reportInBdeScopeSql` has no branch for it): the
  platform admin alone sees it.
- **A profile correction does not drop the feed cache** (30 s, the bound
  [profiles-and-access](../profiles-and-access.md) states); a follow that begins or ends now drops
  its reader's pages.

### Closed by the owner, 2026-11-14

- **The anonymous link preview of a post stays as it is**, for every post but the ones restricted
  to a public (students-only, an institution's students or staff) - the question
  `post-preview.service.ts` left open is answered.
