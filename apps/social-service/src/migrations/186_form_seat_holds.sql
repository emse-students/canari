-- Migration 186: a seat hold behind a "Reserver ma place" button on a capped form (owner, 2026-11-17:
-- "Plus tard (1.8.0)"; docs/wiki/frontend/modules/forms.md, "A capped form may hold a seat for 10
-- minutes behind a button").
--
-- ONE new table, schema only: a signed-in person's explicit intention to answer a capped form, one
-- row per account and form. `seatHoldingWhere`'s count (`forms/seat-hold.ts`, `countSeatsTaken`) adds
-- the holds younger than their 10 minutes, so a hold that expires frees its seat with no sweep (the
-- count reads its age); the submit turns the person's own hold into their answer under the form's seat
-- lock, in the same transaction. A hold is never counted against its own holder.
--
-- NO BACKFILL (nothing holds a seat before this image runs). `form_seat_holds."userId"` is an account
-- id: the erasure deletes it (`account-erasure.ts`). Forms delete their holds (ON DELETE CASCADE).
--
-- ROLLBACK. Nothing reads the table but this feature; an older image ignores it (and counts no hold).
--   DROP TABLE IF EXISTS form_seat_holds;
--
-- LOCKS. CREATE TABLE takes a SHARE ROW EXCLUSIVE lock on `forms` for the foreign key, for the length of
-- the statement (a new empty table); the migration gives up after 5 s rather than queue behind a long
-- transaction. IDEMPOTENT: IF NOT EXISTS.

SET lock_timeout = '5s';

BEGIN;

CREATE TABLE IF NOT EXISTS form_seat_holds (
  "formId" uuid NOT NULL REFERENCES forms (id) ON DELETE CASCADE,
  "userId" varchar(255) NOT NULL,
  "heldAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY ("formId", "userId")
);

COMMIT;
