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
- **Staff in the app.** A staff account (a campus, an empty cursus) has no space: the in-app agenda
  shows it memberships and read grants only, while the signed subscription gives its whole campus
  (`campusWideReaderCampus` is called by the signature alone); the shop, the partnerships and the
  association directory are empty for it. Being built with "Personnel par campus"
  ([owner, 2026-11-14](owner-decisions-of-2026-11-14.md)).
- **The campus and formation admin (G5, WP-D1b)** is not built. Adding a formation or a campus today
  means changing together: `SPACE_FORMATIONS` / `SPACE_CAMPUSES`, the CHECK constraints of
  migrations 071 and 078, `FORMATIONS` / `CAMPUSES` in core-service and the frontend, the enrolment
  blueprint, the audience grid and the agenda filter.

### Dead zones and inconsistencies

- **An unknown formation is accepted at sign-in** (`parseProfileClaims`: any non-empty string, so
  `Master` or `icm`), while the admin edit is strict. The person then holds a cursus that matches
  no space: neither a student of a space nor staff, and nothing is logged. An absent claim clears
  campus and cursus with a debug line only.
- **A stored formation criterion can match nobody**: a form's `formation.values` accepts any string,
  so one saved with the legacy `Master` refuses every submitter.
- **A default audience may be "everyone" on an association**: `smallestRules` collapses "all ten
  spaces" to the (NULL, NULL) rule, which `setAudiences` refuses for the same type - latent, no BDE
  governs ten spaces. `setAudiences` also judges its bound on a read taken outside its transaction.
- **Decision 3 (one campus per association or list) is half enforced** (P5 of the reform): two
  whole-campus rules pass.
- **`/admin/spaces` offers "everyone" to associations and lists** and shows a generic error where
  the server answers a typed refusal.
- **Device copies outlive a withdrawal until the next server answer**: the sealed feed copy has no
  lifetime of its own, and the bell's copy keeps a snippet of a post since withdrawn
  ([local-first-ui](../frontend/local-first-ui.md)). Safe across an account switch.
- **A nickname report reaches no BDE moderator** (`reportInBdeScopeSql` has no branch for it).
- **A follower's own unfollow and a profile correction do not drop the feed cache** (30 s).

### Closed by the owner, 2026-11-14

- **The anonymous link preview of a post stays as it is**, for every post but the ones restricted
  to a public (students-only, an institution's students or staff) - the question
  `post-preview.service.ts` left open is answered.
