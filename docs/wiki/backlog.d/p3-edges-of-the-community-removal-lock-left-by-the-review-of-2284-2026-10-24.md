## P3 - Edges of the community removal lock, left by the review of #2284 (2026-10-24)

target: 1.9.0

- **A salon reorder can deadlock with a departure or a community deletion.** A departure now locks
  the community's private salons in one order (`ORDER BY id`) before the membership rows, and a grant
  and `hardDeleteWorkspace` take salon rows before membership rows (the grant-vs-deletion cycle
  #2284's review found is closed; since 2026-10-26 `hardDeleteWorkspace` also opens with the
  removal lock, so it is serialised with every departure). Left: the reorder transaction writes
  several salon rows in the order the client sent, so it can cross a departure on two salons.
  PostgreSQL aborts one side (`40P01`); an aborted departure settles `cancelled` and is retried
  inline, a reorder is answered 5xx. The fix is the same `ORDER BY id` lock (a `SELECT ... FOR
  UPDATE`) before the bulk write.
- **A group retirement runs after the commit, outside any lock.** A makes a salon public, B makes it
  private again (the idempotent mint returns the same group G), then A's retirement deletes G on
  chat-delivery and nulls `distributionGroupId`: a private salon with no group. The fix is a
  conditional retirement - `UPDATE ... WHERE "distributionGroupId" = G AND NOT "isPrivate"`, and the
  delete only when that row changed.
- **Case.** The removal bound's member map takes the LAST of two membership rows differing only by
  case; it should merge their roles. Allowlist entries written before the actor id was lowercased may
  be mixed case, which `stripFromChannels`' exact compare misses: one `GROUP BY` over production's
  `allowedUsers` for an uppercase letter settles whether any exist. A comma inside a user id would
  corrupt the comma-separated `allowedUsers` column (theoretical).
- **An invitation that reads a salon public and loses the race to a private flip** announces it
  `public` and grants nothing (pre-existing): the flip's allowlist does not name the invitee.

Re-read 2026-11-11: the four edges are unchanged in code; re-read again 2026-12-11.

([social-service](../services/social-service.md#removals-are-bounded-by-the-actor-and-so-is-hiding-a-salon-2026-10-24))
