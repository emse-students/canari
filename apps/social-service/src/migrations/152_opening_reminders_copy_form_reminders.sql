-- canari:hold-for-owner - a BACKFILL: every form reminder ("Me prévenir") becomes an opening reminder.
-- Migration 152 : `form_reminders` folded into `opening_reminders` (engagement WP-4, L9).
--
-- docs/wiki/engagement.md, "(d) openings for followers" and "Which migrations are held". A form
-- reminder IS an opening reminder of kind 'form' asked by its reader, and two stores for one fact
-- diverge, so from this migration on the code reads and writes `opening_reminders` only. The routes
-- `POST|DELETE|GET /api/forms/:id/remind` keep their shape and write the new table. The old table is
-- dropped by a later HELD migration, once WP-4 has served one stable.
--
-- TWO PARTS, IN ONE TRANSACTION, AND THE ORDER IS THE POINT:
--
-- 1. A MIRROR TRIGGER on `form_reminders`. A social-service image older than this migration may
--    still be serving while it runs (a rolling deploy), and it reads and writes the OLD table:
--    - its "Me prévenir" (an INSERT, or the UPDATE its upsert is) becomes the same ask on
--      `opening_reminders` - the statement `askOpeningSql` in `openings/opening-reminders.ts`
--      runs, spelt the same way here;
--    - its unsubscribe and its purge (a DELETE) remove the same row;
--    - its scheduler's CLAIM (a flag going false -> true) is made on `opening_reminders` FIRST, in
--      the same statement: the old row is stamped only when the new row's flag was still unset.
--      Otherwise the trigger cancels the old row's update (RETURN NULL), the old image reads
--      `affected = 0` and pushes nothing. The new image claims the new row only. So an opening
--      due while both images run is pushed by exactly one of them - never two, never none.
--    The new code never writes the old table, so the trigger never loops.
-- 2. THE COPY of every existing reminder, as 'asked'. `LOCK TABLE ... SHARE ROW EXCLUSIVE` first: a
--    concurrent write by an old image waits for this transaction, then fires the trigger - so every
--    row is either copied here or mirrored after COMMIT, never neither.
--
-- `ON CONFLICT DO NOTHING` on the copy: 151 and this file ship in the same release (a held file
-- blocks the release until approved), so no new image has written `opening_reminders` before the
-- copy, and a replay finds every row present and writes nothing. The row keeps its id.
--
-- Idempotent for CD: CREATE OR REPLACE FUNCTION, DROP TRIGGER IF EXISTS before CREATE TRIGGER, ON
-- CONFLICT DO NOTHING. LOCKS: SHARE ROW EXCLUSIVE on `form_reminders` (one row per "Me prévenir")
-- from the LOCK to COMMIT - reminder writes wait a few milliseconds, reads go on; gives up after
-- 5 s rather than queue (the re-run is safe).
--
-- The trigger and its function go with the table's held drop: that migration must
-- `DROP FUNCTION canari_form_reminder_to_opening()` as well as the table.
--
-- ROLLBACK: an image older than this migration reads `form_reminders`, which the trigger keeps
-- whole only in one direction (old -> new). An ask through the NEW code after this is not seen by an
-- older image; forward-only by intent, like every migration here.

SET lock_timeout = '5s';

BEGIN;

LOCK TABLE form_reminders IN SHARE ROW EXCLUSIVE MODE;

CREATE OR REPLACE FUNCTION canari_form_reminder_to_opening() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  claims_heads_up boolean;
  claims_opening boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM opening_reminders
     WHERE kind = 'form' AND "targetId" = OLD."formId" AND "userId" = OLD."userId";
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    claims_heads_up := NOT OLD."notified5min" AND NEW."notified5min";
    claims_opening := NOT OLD."notifiedOnOpen" AND NEW."notifiedOnOpen";
    IF claims_heads_up OR claims_opening THEN
      UPDATE opening_reminders
         SET "notified5min" = "notified5min" OR claims_heads_up,
             "notifiedOnOpen" = "notifiedOnOpen" OR claims_opening
       WHERE kind = 'form' AND "targetId" = NEW."formId" AND "userId" = NEW."userId"
         AND (NOT claims_heads_up OR NOT "notified5min")
         AND (NOT claims_opening OR NOT "notifiedOnOpen");
      IF NOT FOUND THEN
        RETURN NULL;
      END IF;
      RETURN NEW;
    END IF;
  END IF;
  INSERT INTO opening_reminders AS o (kind, "targetId", "userId", "opensAt", origin)
  VALUES ('form', NEW."formId", NEW."userId", NEW."opensAt", 'asked')
  ON CONFLICT (kind, "targetId", "userId") DO UPDATE
    SET origin = 'asked',
        "opensAt" = EXCLUDED."opensAt",
        "notified5min" = CASE WHEN EXCLUDED."opensAt" > now() THEN false ELSE o."notified5min" END,
        "notifiedOnOpen" = CASE WHEN EXCLUDED."opensAt" > now() THEN false ELSE o."notifiedOnOpen" END;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS canari_form_reminder_claim ON form_reminders;
CREATE TRIGGER canari_form_reminder_claim
  BEFORE UPDATE ON form_reminders
  FOR EACH ROW EXECUTE FUNCTION canari_form_reminder_to_opening();

DROP TRIGGER IF EXISTS canari_form_reminder_to_opening ON form_reminders;
CREATE TRIGGER canari_form_reminder_to_opening
  AFTER INSERT OR DELETE ON form_reminders
  FOR EACH ROW EXECUTE FUNCTION canari_form_reminder_to_opening();

INSERT INTO opening_reminders
  (id, kind, "targetId", "userId", "opensAt", origin, "notified5min", "notifiedOnOpen", "createdAt")
SELECT id, 'form', "formId", "userId", "opensAt", 'asked', "notified5min", "notifiedOnOpen",
       "createdAt"
  FROM form_reminders
ON CONFLICT DO NOTHING;

COMMIT;
