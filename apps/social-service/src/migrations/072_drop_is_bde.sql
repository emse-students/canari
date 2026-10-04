-- WP6c: "being a BDE" is now `spaces."bdeAssociationId"` and nothing else. The boolean column an admin
-- ticked is dropped, never kept beside the new model.
--
-- REFUSES to drop while an association carries `isBDE` and is the BDE of NO space: that flag is the
-- only thing granting its members VALIDATE_EVENTS / MANAGE_ASSO / MODERATE, and 071 designates a BDE
-- only when exactly ONE association had it. Several flagged ones (or none seeded) must be designated
-- on the spaces page first, or this migration would silently remove their powers.
DO $$
DECLARE
    orphans TEXT;
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'associations' AND column_name = 'isBDE'
    ) THEN
        SELECT string_agg(a.name, ', ') INTO orphans
        FROM associations a
        WHERE a."isBDE" = true
          AND NOT EXISTS (SELECT 1 FROM spaces s WHERE s."bdeAssociationId" = a.id);
        IF orphans IS NOT NULL THEN
            RAISE EXCEPTION 'isBDE association(s) govern no space: % - designate them on /admin/spaces first', orphans;
        END IF;
        ALTER TABLE associations DROP COLUMN "isBDE";
    END IF;
END $$;
