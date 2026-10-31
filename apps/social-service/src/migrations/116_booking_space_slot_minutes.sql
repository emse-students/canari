-- Migration 116: the STORED length of a fixed slot ("Painting a fixed-slot space" in
-- docs/wiki/bookings-chantier.md, decided by the owner on 2026-10-29).
--
-- `booking_spaces."slotMinutes"`: how long one fixed slot of a 'slots' space lasts, the length the
-- creation wizard cut its lines with and the settings' mode switch chose. The painter opens new slots
-- of this length; before it the length was stored nowhere and the painter inferred it from the
-- week's most common line, falling back to the 30-min grain on an emptied week.
--
-- NULL on every 'step' space (the CHECK below mirrors `booking_spaces_step_shape`: a step space
-- carries no slot length, as a slots space carries no step), and NULL on a 'slots' space created
-- before this migration: NO BACKFILL - such a space keeps inferring its length from its lines, which
-- is what it did yesterday. The range is the wizard's (15 to 120 minutes).
--
-- No personal data is added: one number describing a space's configuration.
--
-- ROLLBACK: an image older than this migration ignores the column. One save of an old image is
-- refused by the CHECK: switching a space that holds a length to 'step' (it does not clear a column
-- it does not know) - a failed save, never a corrupt row.
-- Idempotent for CD: IF NOT EXISTS, and the CHECK guarded by a catalogue check on this schema.

SET lock_timeout = '5s';

ALTER TABLE booking_spaces ADD COLUMN IF NOT EXISTS "slotMinutes" integer NULL;

DO $$
DECLARE
  ns oid := to_regnamespace(current_schema())::oid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'booking_spaces_slot_minutes' AND connamespace = ns
  ) THEN
    ALTER TABLE booking_spaces ADD CONSTRAINT booking_spaces_slot_minutes
      CHECK ("slotMinutes" IS NULL OR ("slotMode" = 'slots' AND "slotMinutes" BETWEEN 15 AND 120));
  END IF;
END $$;
