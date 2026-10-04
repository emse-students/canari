-- Migration 071: spaces (WP6a of the profile reform, docs/wiki/profiles-and-access.md, D16-D22).
--
-- A SPACE is a formation x campus pair (ICM Saint-Etienne, ISMIN Gardanne, ...). It exists only once
-- an admin has opened it (D17), and has at most ONE BDE (D22). An association belongs to one or more
-- spaces (D19) and a post may be widened to extra spaces (D19, nominative). This migration is DATA
-- ONLY: nothing reads these tables yet - the readers (6b) and the admin page (6d) come next - so
-- applying it changes nothing a user sees.
--
-- THE SEED IS THE WORLD AS IT IS TODAY: one space, ICM x saint-etienne, every existing association
-- and list attached to it, and today's `isBDE` association as its BDE. The BDE is set ONLY when
-- exactly one association carries `isBDE`: with zero or several there is no honest choice to make,
-- so the column stays NULL and a notice says so - an admin designates it on the 6d page. The
-- `isBDE` column stays until 6c deletes it; it is never kept beside the new model for good.
--
-- `associations.type` gains 'institution' with 6e, not here: nothing could create one yet.
-- FKs cascade: a deleted association, post or space leaves no orphan row behind.
-- Idempotent: the deploy ledger replays a file whose predecessor failed mid-run.

CREATE TABLE IF NOT EXISTS spaces (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    formation           VARCHAR(16) NOT NULL,
    campus              VARCHAR(32) NOT NULL,
    "openedAt"          TIMESTAMPTZ NOT NULL DEFAULT now(),
    "bdeAssociationId"  UUID NULL REFERENCES associations (id) ON DELETE SET NULL,
    CONSTRAINT "UQ_spaces_formation_campus" UNIQUE (formation, campus),
    CONSTRAINT "CHK_spaces_formation" CHECK (formation IN ('ICM', 'ISMIN', 'FSSS', 'Autre')),
    CONSTRAINT "CHK_spaces_campus" CHECK (campus IN ('saint-etienne', 'gardanne'))
);

-- One BDE governs one space, and an association is the BDE of at most one (D22).
CREATE UNIQUE INDEX IF NOT EXISTS "UQ_spaces_bdeAssociationId"
    ON spaces ("bdeAssociationId") WHERE "bdeAssociationId" IS NOT NULL;

CREATE TABLE IF NOT EXISTS association_spaces (
    "associationId" UUID NOT NULL REFERENCES associations (id) ON DELETE CASCADE,
    "spaceId"       UUID NOT NULL REFERENCES spaces (id) ON DELETE CASCADE,
    PRIMARY KEY ("associationId", "spaceId")
);
CREATE INDEX IF NOT EXISTS "IDX_association_spaces_space" ON association_spaces ("spaceId");

CREATE TABLE IF NOT EXISTS post_extra_spaces (
    "postId"  UUID NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
    "spaceId" UUID NOT NULL REFERENCES spaces (id) ON DELETE CASCADE,
    PRIMARY KEY ("postId", "spaceId")
);
CREATE INDEX IF NOT EXISTS "IDX_post_extra_spaces_space" ON post_extra_spaces ("spaceId");

INSERT INTO spaces (formation, campus) VALUES ('ICM', 'saint-etienne')
    ON CONFLICT (formation, campus) DO NOTHING;

INSERT INTO association_spaces ("associationId", "spaceId")
    SELECT a.id, s.id FROM associations a
    CROSS JOIN spaces s WHERE s.formation = 'ICM' AND s.campus = 'saint-etienne'
    ON CONFLICT DO NOTHING;

UPDATE spaces SET "bdeAssociationId" = (SELECT id FROM associations WHERE "isBDE" = true)
    WHERE formation = 'ICM' AND campus = 'saint-etienne' AND "bdeAssociationId" IS NULL
      AND (SELECT count(*) FROM associations WHERE "isBDE" = true) = 1;

DO $$
DECLARE n integer;
BEGIN
    SELECT count(*) INTO n FROM associations WHERE "isBDE" = true;
    IF n <> 1 THEN
        RAISE NOTICE 'spaces seed: % association(s) carry isBDE - the BDE of ICM x saint-etienne is left unset', n;
    END IF;
END $$;
