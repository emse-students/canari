-- Migration 117: `post_notifications."meta"`, the structured facts of a notice (the bookings' slot).
--
-- A booking notice (`booking_cancelled`, `booking_withdrawn`, `booking_added`) must name WHERE and
-- WHEN: the place, the slot's START as a UTC instant, and the space's IANA time zone, so the client
-- draws the day and the time on the space's clock in the reader's language. `text` stays what it
-- was for a person to read (the organiser's word alone, or empty) - nothing is ever parsed out of it.
--
-- NULL on every row written before this migration and on every other type: such a row renders
-- exactly as it did yesterday. NO BACKFILL.
--
-- Personal data: the place's name and a slot's start - no account reference. Kept and deleted with
-- the row (90 days, like any notice), including after the space is deleted: the row does not
-- point at the space.
--
-- ROLLBACK: an image older than this migration ignores the column; nothing it writes breaks it.
-- Idempotent for CD: IF NOT EXISTS.

SET lock_timeout = '5s';

ALTER TABLE post_notifications ADD COLUMN IF NOT EXISTS "meta" jsonb NULL;
