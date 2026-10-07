-- Migration 074: event co-organisation by proposal (D39), decided by the user on 2026-10-04
-- (docs/wiki/profiles-and-access.md, "D39 co-organisation as built").
--
-- UNTIL NOW A CO-ORGANISER WAS ADDED WITHOUT ITS CONSENT and held every right on the event at once.
-- From here, naming one is a PROPOSAL of kind 'coorganise' (subject = the event) on the generic
-- `proposals` table of migration 073; its row in `association_calendar_event_co_owners` is written
-- only when its publishers ACCEPT. So that table now means "accepted co-organisers", and everything
-- that reads it - the rights (`findCalendarEventForAssociation`) and the reach of the event
-- (`eventVisibleToUserSql`) - reads consent.
--
-- EXISTING CO-OWNER ROWS ARE ACCEPTED, NOT DROPPED. They exist today and carry rights; a backfill
-- that discarded them would silently take those rights away and shrink the events' reach. Each one
-- gets an `accepted` proposal (decided by 'migration-074'), so the event form shows it as accepted
-- and the unique index of 073 refuses to propose the same pair again while it stands.
--
-- Idempotent: the deploy ledger replays a file whose predecessor failed mid-run. Every statement
-- below is guarded (IF EXISTS / IF NOT EXISTS / NOT EXISTS / OR REPLACE), and the integration spec
-- runs this file twice.

-- 1. The kind.
ALTER TABLE proposals DROP CONSTRAINT IF EXISTS "CHK_proposals_kind";
ALTER TABLE proposals ADD CONSTRAINT "CHK_proposals_kind" CHECK (kind IN ('repost', 'coorganise'));

-- 2. One row per (event, association). The table was created by TypeORM `synchronize` with no unique
-- key, so a duplicate pair may exist; the extra copies carry nothing the first does not, and the
-- index below needs them gone. Orphans of an event deleted before the trigger at the end existed
-- are removed for the same reason: they name nothing.
DELETE FROM association_calendar_event_co_owners dup
 USING association_calendar_event_co_owners keep
 WHERE dup.event_id = keep.event_id
   AND dup.association_id = keep.association_id
   AND dup.id > keep.id;
DELETE FROM association_calendar_event_co_owners co
 WHERE NOT EXISTS (SELECT 1 FROM association_calendar_events e WHERE e.id = co.event_id);
CREATE UNIQUE INDEX IF NOT EXISTS "UQ_calendar_event_co_owner"
    ON association_calendar_event_co_owners (event_id, association_id);

-- 3. The backfill: every existing co-organiser is an accepted proposal from the event's organiser.
-- A row naming the organiser itself is not a co-organisation (the service never wrote one) and is
-- skipped, since the CHECK of 073 forbids a proposal to oneself.
INSERT INTO proposals (kind, "subjectId", "fromAssociationId", "toAssociationId", status,
                       "proposedBy", "decidedBy", "createdAt", "decidedAt")
SELECT 'coorganise', co.event_id, e."associationId", co.association_id, 'accepted',
       e."createdBy", 'migration-074', e."createdAt", now()
  FROM association_calendar_event_co_owners co
  JOIN association_calendar_events e ON e.id = co.event_id
 WHERE co.association_id <> e."associationId"
   AND NOT EXISTS (
       SELECT 1 FROM proposals p
        WHERE p.kind = 'coorganise'
          AND p."subjectId" = co.event_id
          AND p."toAssociationId" = co.association_id
          AND p.status <> 'withdrawn');

-- 4. A deleted event takes its co-organisers and its proposals with it, by whatever path (a user, a
-- BDE, an association deletion cascading through its events). `subjectId` carries no foreign key -
-- it names a different table per kind - and the co-owner table never had one on `event_id`.
CREATE OR REPLACE FUNCTION proposals_drop_deleted_event() RETURNS trigger AS $$
BEGIN
    DELETE FROM proposals WHERE kind = 'coorganise' AND "subjectId" = OLD.id;
    DELETE FROM association_calendar_event_co_owners WHERE event_id = OLD.id;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "TRG_calendar_events_drop_coorganise" ON association_calendar_events;
CREATE TRIGGER "TRG_calendar_events_drop_coorganise"
    AFTER DELETE ON association_calendar_events
    FOR EACH ROW EXECUTE FUNCTION proposals_drop_deleted_event();
