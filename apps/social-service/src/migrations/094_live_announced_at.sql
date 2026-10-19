-- Migration 094: lives."announcedAt" - the durable record that a live's start was pushed to the
-- broadcaster's followers (WP-L7 of docs/wiki/frontend/modules/live.md, decision L10).
--
-- ONE PUSH PER LIVE, AND IDEMPOTENCE FROM THIS COLUMN, NEVER FROM A CLOCK: the confirm of segment 0
-- stamps it (`WHERE "announcedAt" IS NULL`) in the same transaction, under the same row lock, as the
-- segment itself, and the push follows that commit - so a repeat of segment 0, a reconnect or a
-- second instance matches nothing. See docs/wiki/services/lives.md.
--
-- The rows that exist when the column is ADDED are stamped with their start. Nothing sweeps for
-- unannounced lives - only segment 0's confirm ever claims one - so the one live this changes is a
-- live caught MID-START by the deploy (its row written, its segment 0 not yet confirmed): it is
-- never announced, where it would otherwise be the first push of a feature that did not exist when
-- it began. Only then: the block runs the backfill in the same step that creates the column, so a
-- re-run (the deploy re-applies a file whose successor failed) touches nothing.
--
-- No personal data: a timestamp on a row the account erasure already ends and the sweep deletes.
-- 094: the next free number on main (093 is its highest, 2026-10-19).

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'lives' AND column_name = 'announcedAt'
  ) THEN
    ALTER TABLE lives ADD COLUMN "announcedAt" timestamptz NULL;
    UPDATE lives SET "announcedAt" = "startedAt";
  END IF;
END
$$;
