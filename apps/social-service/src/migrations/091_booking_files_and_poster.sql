-- Migration 091: a booking's FILE answers, and a space's POSTER (WP-B6 of
-- docs/wiki/bookings-chantier.md, decisions D7, D8, D18, D22, D35, D41).
--
-- 1. `booking_spaces.poster`: the space's poster, a media reference (`mediaId`, `key`, `iv`,
--    `mimeType`, `size`, `width`, `height`) - ENCRYPTED BY THE CLIENT like a post's image (a per-file
--    key, travelling in this row; the media service holds ciphertext only). NULL: no poster.
--
-- 2. `booking_files`: what a FILE answer's id names - the forms' `form_files` (migration 085) for a
--    booking. The bytes are the media service's class `form-file` (plaintext, read by social-service
--    alone, for the organiser - D22), so one storage serves both modules. THE STATE IS THE ROW:
--    - "bookingId" IS NULL, "purgedAt" NULL: uploaded and not yet sent with a booking. Attachable for
--      one day after "createdAt", then purged (blob, then row). A deleted booking (its space deleted,
--      D27, or past the one-year maximum age, D19) sets it back to NULL, so its file joins that purge.
--    - "bookingId" set, "purgedAt" NULL: a booking's file, readable by the organiser, purged
--      `booking_spaces."retentionDays"` after the END OF ITS SLOT (D8, D23, D41).
--    - "purgedAt" set: the blob is gone and the row says so - the organiser reads "file deleted".
--
--    No foreign key on "spaceId": a deleted space's files must stay listed until the purge has taken
--    their blobs - a cascade would delete the only record of them (085's reasoning, for a form).
--
-- Idempotent for CD: IF NOT EXISTS / a catalogue check everywhere.

ALTER TABLE booking_spaces ADD COLUMN IF NOT EXISTS poster jsonb NULL;

CREATE TABLE IF NOT EXISTS booking_files (
  id uuid PRIMARY KEY,
  "spaceId" uuid NOT NULL,
  "itemId" varchar(64) NOT NULL,
  "uploaderId" varchar(255) NOT NULL,
  "contentType" varchar(64) NOT NULL,
  "fileName" varchar(255) NOT NULL,
  "sizeBytes" integer NOT NULL,
  "bookingId" uuid NULL,
  "purgedAt" timestamptz NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);

-- The catalogue check is scoped to THIS schema (087's form): a constraint of the same name in
-- another schema must not skip this one's.
DO $$
DECLARE
  ns oid := to_regnamespace(current_schema())::oid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'booking_files_booking_fk' AND connamespace = ns) THEN
    ALTER TABLE booking_files
      ADD CONSTRAINT booking_files_booking_fk FOREIGN KEY ("bookingId")
      REFERENCES bookings (id) ON DELETE SET NULL;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS booking_files_space_idx ON booking_files ("spaceId");
CREATE INDEX IF NOT EXISTS booking_files_booking_idx ON booking_files ("bookingId");
-- The purge's predicates read only rows not yet purged.
CREATE INDEX IF NOT EXISTS booking_files_live_idx ON booking_files ("createdAt") WHERE "purgedAt" IS NULL;
