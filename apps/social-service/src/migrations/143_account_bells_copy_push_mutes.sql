-- canari:hold-for-owner - a BACKFILL: every association push mute becomes a bell at level 'none'.
-- Migration 143 : `association_push_mutes` folded into `account_bells` (engagement WP-3, L8).
--
-- docs/wiki/engagement.md, "The bell - data model" and "Which migrations are held". A mute IS the
-- bell's `none` on an entity, and two stores for one fact diverge, so from this migration on the
-- code reads and writes `account_bells` only: the old mute endpoints stay, for builds older than the
-- bell control, and write `account_bells` (mute = 'none', unmute = delete the row) - the shim listed
-- in docs/wiki/legacy-compatibility.md with its removal condition. The old table is then dropped by a
-- later HELD migration, once nothing older than the bell control can reach a server older than this.
--
-- TWO PARTS, IN ONE TRANSACTION, AND THE ORDER IS THE POINT:
--
-- 1. A MIRROR TRIGGER on `association_push_mutes`. A social-service image older than this migration
--    may still be serving while it runs (a rolling deploy) and writes its mutes to the old table: a
--    mute written there after the copy would be read by nothing and lost. The trigger turns every
--    such write into the same write on `account_bells` - an insert, or the UPDATE an old image's
--    upsert of an existing mute is, into level 'none'; a delete into the row's removal - so no
--    window exists, whatever the deploy's order. It also carries an association's deletion (the old table's foreign key cascades, and a row trigger fires on a
--    cascaded delete). The new code never writes the old table, so the trigger never loops.
-- 2. THE COPY of every existing mute. `LOCK TABLE ... SHARE ROW EXCLUSIVE` first: a concurrent
--    mute waits for this transaction, then fires the trigger - so every row is either copied here
--    or mirrored after COMMIT, never neither.
--
-- `ON CONFLICT DO NOTHING` on the copy: a bell row already present (written through the new code
-- between migration 142 and this one) is the reader's newer choice and is kept. A replay finds every
-- row present and writes nothing.
--
-- Idempotent for CD: CREATE OR REPLACE FUNCTION, DROP TRIGGER IF EXISTS before CREATE TRIGGER, ON
-- CONFLICT DO NOTHING. LOCKS: SHARE ROW EXCLUSIVE on `association_push_mutes` (a small table: one row
-- per mute) from the LOCK to COMMIT - mutes and unmutes wait a few milliseconds, reads go on; gives up
-- after 5 s rather than queue (the re-run is safe).
--
-- ROLLBACK: an image older than this migration reads `association_push_mutes`, which the trigger
-- keeps whole only in one direction (old -> new). A mute set through the NEW code after this would
-- not be seen by an older image; forward-only by intent, like every migration here.

SET lock_timeout = '5s';

BEGIN;

LOCK TABLE association_push_mutes IN SHARE ROW EXCLUSIVE MODE;

CREATE OR REPLACE FUNCTION canari_push_mute_to_bell() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    INSERT INTO account_bells ("userId", "targetKind", "targetId", level)
    VALUES (NEW."userId", 'association', NEW."associationId"::text, 'none')
    ON CONFLICT ("userId", "targetKind", "targetId")
      DO UPDATE SET level = 'none', "updatedAt" = now();
    RETURN NEW;
  END IF;
  DELETE FROM account_bells
   WHERE "userId" = OLD."userId" AND "targetKind" = 'association'
     AND "targetId" = OLD."associationId"::text;
  RETURN OLD;
END
$fn$;

DROP TRIGGER IF EXISTS canari_push_mute_to_bell ON association_push_mutes;
CREATE TRIGGER canari_push_mute_to_bell
  AFTER INSERT OR UPDATE OR DELETE ON association_push_mutes
  FOR EACH ROW EXECUTE FUNCTION canari_push_mute_to_bell();

INSERT INTO account_bells ("userId", "targetKind", "targetId", level)
SELECT "userId", 'association', "associationId"::text, 'none' FROM association_push_mutes
ON CONFLICT DO NOTHING;

COMMIT;
