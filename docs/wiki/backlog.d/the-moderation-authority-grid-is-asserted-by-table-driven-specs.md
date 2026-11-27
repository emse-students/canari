## The moderation authority grid is asserted by one table-driven spec per service (owner, 2026-11-15)

target: 1.9.1

**What.** [moderation-authority](../moderation-authority.md) is the one copy of who may do what to
whom. Nothing checks it against the code, so it would drift. Write it as ONE table-driven spec per
service, each row `{ grid, action, role, expected }` named after a row and a column of the page, run
on the REAL predicates (never a mock of `mayModeratePost`):

- `apps/social-service/src/moderation/moderation-authority.grid.integration.spec.ts`, against
  PostgreSQL (the harness of `spaces/bde-moderation.integration.spec.ts`). ONE fixture: a space
  governed by a BDE (type `association`), a space governed by an INSTITUTION with no BDE, an
  association whose parent is the BDE, a parentless association, an institution, a community with a
  moderator role, and one person per role of the page (AP, BM, IM, HO, AU, BC, SA, AV, CM, RD).
  Grids: posts, comments, lives, agenda, forms, people (mute, bio, nicknames), reports queue, journal
  and notice.
- `apps/chat-delivery-service/src/controllers/members.controller.grid.spec.ts`: every admitted member
  adds and removes anyone; a platform admin who is not a member is refused.

**This entry lands the spec with TODAY's answers wherever today already meets the target**, and
writes every GAP as an `it.todo` naming its tag. A gap is defined on the page, countably: **every grid
cell carrying a bracketed tag** (`[HIDE]`, `[NICK]`, `[LIVE]`, `[AGENDA]`,
`[MUTE]`, `[JOURNAL]`, `[NOTICE]`, `[BIO]`, `[AUTOHIDE]`, `[MLS]`; the page defines what a tag is),
one `it.todo` per tag of the cell. So a gap is visible in the test report, never a silent pass.
Each work package turns its rows into real assertions in the pull
request that closes it, and removes the tag from the page in the same pull request.

**A parity guard**: `.github/scripts/tests/moderation-grid-parity.test.mjs` reads the `Action` column
of every grid of the page and fails when the spec names no row for one (and the reverse), so a row
added to the page without a test - or a test without a row - fails `make test-ci-scripts`.

**Proof.** The two specs and the parity guard pass on `main`, and the parity guard asserts that the
number of `it.todo` rows per tag equals the number of grid cells carrying that tag on the page.
