## The moderation authority grid is asserted by one table-driven spec per service (owner, 2026-11-15)

target: 1.8.0

**What.** [moderation-authority](../moderation-authority.md) is the one copy of who may do what to
whom. Nothing checks it against the code, so it would drift. Write it as ONE table-driven spec per
service, each row `{ grid, action, role, expected }` named after a row and a column of the page, run
on the REAL predicates (never a mock of `mayModeratePost`):

- `apps/social-service/src/moderation/moderation-authority.grid.integration.spec.ts`, against
  PostgreSQL (the harness of `spaces/bde-moderation.integration.spec.ts`). ONE fixture: a space
  governed by a BDE (type `association`), a space governed by an INSTITUTION with no BDE, an
  association whose parent is the BDE, a parentless association, an institution, a community with a
  moderator role, and one person per role of the page (AP, BM, IM, HO, AU, BC, SA, AV, CM, RD).
  Grids: posts, comments, lives, agenda, forms, people (mute, nicknames), reports queue.
- `apps/chat-delivery-service/src/controllers/members.controller.grid.spec.ts`: every admitted member
  adds and removes anyone; a platform admin who is not a member is refused.

**This entry lands the spec with TODAY's answers wherever today already meets the target**, and marks
every row that is a gap with the tag of the work package that will flip it (`[IM]`, `[WR]`, `[HIDE]`,
`[NICK]`, `[LIVE]`, `[AGENDA]`, `[MUTE]`, `[MLS]`) as an `it.todo` naming that entry - so a gap is
visible in the test report, never a silent pass. Each work package turns its rows into real
assertions in the pull request that builds it.

**A parity guard**: `.github/scripts/tests/moderation-grid-parity.test.mjs` reads the `Action` column
of every grid of the page and fails when the spec names no row for one (and the reverse), so a row
added to the page without a test - or a test without a row - fails `make test-ci-scripts`.

**Proof.** The two specs and the parity guard pass on `main`; the `it.todo` count equals the number of
bold `today:` cells of the page.
