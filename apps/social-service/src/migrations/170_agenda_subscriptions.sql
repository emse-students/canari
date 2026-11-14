-- Migration 170: the agenda subscription link is its holder's (owner, 2026-11-14, "Respecter les
-- publics"; docs/wiki/profiles-and-access.md, "D40 re-decided 2026-11-14 - the link is its holder's").
--
-- A calendar app polls an `.ics` URL with no identity. Until now that URL carried a signature of a
-- SELECTION (campus, formation, association) and named no one, so it served what the selection
-- reached, whoever held it. From now on the link names a ROW of this table: the token is
-- `<id>.<HMAC of the id>` (`agenda-subscription.ts`), and the feed it opens is EXACTLY the signed-in
-- agenda of the row's `userId`, narrowed to the row's selection, re-evaluated at every poll.
--
-- - `userId`: the holder, an account id (varchar(255), never uuid: `user-id-column.spec.ts`). No
--   foreign key: `users` is core-service's table. The account erasure deletes the holder's rows
--   (`account-erasure.ts`), so an erased account's links answer 403.
-- - `campus`, `formation`: the selection as the selector named it, NULL = "any" (the D4/D6 values,
--   checked by the route before the row is written). Both NULL with an `associationId` is one
--   association's agenda.
-- - `associationId`: one association's agenda, or NULL. Deleting the association deletes the rows.
--
-- ONE ROW PER (holder, selection), NULLs counted equal (PostgreSQL 15+, every estate runs 18): asking
-- twice for the same selection - the subscribe modal asks while it is open - writes nothing new and
-- gives the same link back (`INSERT ... ON CONFLICT DO NOTHING`, then a read).
--
-- REVOCATION is deleting the holder's rows (`DELETE /api/associations/calendar/subscriptions`): the
-- next request mints a new id, so a new link, and every link handed out before answers 403.
--
-- ADDITIVE: a new table and its two indexes, no existing row read or changed. The foreign key takes
-- a brief lock on `associations`; the migration gives up after 5 s rather than queue behind a long
-- transaction. ROLLBACK: an older image never reads this table and serves the signed selections it
-- always did. Idempotent for CD: IF NOT EXISTS.

SET lock_timeout = '5s';

BEGIN;

CREATE TABLE IF NOT EXISTS agenda_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" varchar(255) NOT NULL,
  campus varchar(32) NULL,
  formation varchar(16) NULL,
  "associationId" uuid NULL REFERENCES associations(id) ON DELETE CASCADE,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "UQ_agenda_subscriptions_selection"
  ON agenda_subscriptions ("userId", campus, formation, "associationId") NULLS NOT DISTINCT;

-- The association delete's cascade finds its rows through this, not by a scan.
CREATE INDEX IF NOT EXISTS "IDX_agenda_subscriptions_association"
  ON agenda_subscriptions ("associationId");

COMMIT;
