-- Migration 088: the withdrawal delay of a bookings space binds the PARTICIPANTS, not the holder.
--
-- Decided by the user on 2026-10-17 (docs/wiki/bookings-chantier.md, D5): to avoid last-minute
-- withdrawals, a PARTICIPANT may leave a booking only up to a minimum delay before its start,
-- configurable per space (0 = free until the start); the HOLDER and the organiser may cancel at any
-- time before the start. 087 named the column after the holder's delay, which no longer exists, so
-- the column is RENAMED rather than doubled: a second column would leave a setting nothing reads.
-- Nothing has read or written the column yet (no route before WP-B3), so its meaning moves with no
-- data to translate; the default (0) and the CHECK (>= 0, which follows the rename) are unchanged.
--
-- Idempotent for CD: each rename runs only while the old name exists in the current schema.

DO $$
DECLARE
  ns oid := to_regnamespace(current_schema())::oid;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'booking_spaces'
       AND column_name = 'withdrawalDelayMinutes'
  ) THEN
    ALTER TABLE booking_spaces RENAME COLUMN "withdrawalDelayMinutes" TO "participantWithdrawMinMinutes";
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'booking_spaces_withdrawal_delay' AND connamespace = ns
  ) THEN
    ALTER TABLE booking_spaces
      RENAME CONSTRAINT booking_spaces_withdrawal_delay TO booking_spaces_participant_withdraw_min;
  END IF;
END
$$;
