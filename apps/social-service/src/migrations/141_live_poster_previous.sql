-- Migration 141: the poster a live REPLACED is remembered one round, so a list read before the
-- replacement still finds its object (docs/wiki/services/lives.md, "the previous poster survives").
--
-- "posterPreviousName" uuid NULL: the poster named by "posterName" before the last confirm. The
-- confirm swaps it in the SAME UPDATE that names the new poster, and deletes the one it displaces
-- (the one before that), so a live holds at most TWO poster objects, the current and the previous.
-- The end-of-live purge deletes the whole `live/<id>/` prefix, so it takes both.
--
-- ADDITIVE: one nullable column, no default, no CHECK (a catalogue change, no rewrite). The previous
-- release neither reads nor writes it, so the overlap deploy and a rollback are safe.
-- Idempotent for CD: IF NOT EXISTS.
-- LOCKS: ACCESS EXCLUSIVE on `lives` for the catalogue change (a handful of rows); a request holding
-- the lock makes the migration give up after 5 s rather than queue (the re-run is safe).

SET lock_timeout = '5s';

ALTER TABLE lives ADD COLUMN IF NOT EXISTS "posterPreviousName" uuid;
