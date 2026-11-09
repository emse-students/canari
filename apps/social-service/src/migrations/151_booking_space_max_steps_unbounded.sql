-- Migration 151: a step space may have NO longest booking (owner, 2026-11-09: a new space is
-- limitless until its organiser sets "Durée maximale d'une réservation" in the booking rules).
--
-- `booking_spaces."maxSteps"` NULL on a 'step' space now means "no limit". The CHECK
-- `booking_spaces_step_shape` required it to be >= 1 there, so it is re-created with
-- `"maxSteps" IS NULL OR "maxSteps" >= 1` for a step space; the 'slots' branch is unchanged
-- (a slots space still carries neither a step nor a maximum).
--
-- Non-destructive: the constraint only gets wider, every stored row still satisfies it, NO BACKFILL
-- (existing spaces keep their stored maximum until an organiser empties the field). No personal
-- data is added or read.
--
-- ROLLBACK: an image older than this migration reads a NULL maxSteps as one step; the previous
-- CHECK would refuse a space saved with no maximum, so re-adding it needs those rows set first.
-- Idempotent for CD: re-created only while the stored definition is still the strict one.

SET lock_timeout = '5s';

DO $$
DECLARE
  ns oid := to_regnamespace(current_schema())::oid;
  def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def
    FROM pg_constraint WHERE conname = 'booking_spaces_step_shape' AND connamespace = ns;
  IF def IS NULL OR def LIKE '%"maxSteps" IS NULL OR%' THEN
    RETURN;
  END IF;
  ALTER TABLE booking_spaces DROP CONSTRAINT booking_spaces_step_shape;
  ALTER TABLE booking_spaces ADD CONSTRAINT booking_spaces_step_shape CHECK (
    ("slotMode" = 'step' AND COALESCE("stepMinutes", 0) > 0 AND ("maxSteps" IS NULL OR "maxSteps" >= 1))
    OR ("slotMode" = 'slots' AND "stepMinutes" IS NULL AND "maxSteps" IS NULL)
  );
END $$;
