-- Migration 071: spaces (WP6a of the profile reform, docs/wiki/profiles-and-access.md, D16-D22).
--
-- A SPACE is a formation x campus pair (ICM Saint-Etienne, ISMIN Gardanne, ...). All the pairs
-- exist (D17, relaxed 2026-10-04: nothing is opened), and one has at most ONE BDE (D22, which may govern several spaces). This migration is DATA ONLY: nothing
-- reads these tables yet - the readers (6b) and the admin page (6d) come next - so applying it
-- changes nothing a user sees.
--
-- WHO AN ASSOCIATION ADDRESSES IS A RULE, NOT A LIST OF SPACES (user, 2026-10-04: the ME of
-- Saint-Etienne and the School's Saint-Etienne pole address the Saint-Etienne campus ONLY). An
-- `association_audiences` row is (formation, campus) where NULL means "any": (ICM, saint-etienne) is
-- one space, (NULL, saint-etienne) is every formation on that campus, (NULL, NULL) is everyone. An
-- association has one or more rows (an ICM Saint-Etienne association that also addresses FSSS has
-- two - D19). The rule is resolved against the OPEN spaces at read time (6b), so a space opened
-- later is reached with no edit to any association. Same table for associations, lists and the
-- institutions of 6e (the School: everything; each ME: its campus). These rules are the entity's
-- CEILING - the post table below lets an author choose within it.
--
-- THE SEED IS THE WORLD AS IT IS TODAY: one space, ICM x saint-etienne, every existing association
-- and list addressing it, and today's `isBDE` association as its BDE. The BDE is set ONLY when
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

-- NO unique index on "bdeAssociationId": a space has one BDE, but an association may be the BDE of
-- several spaces (user, 2026-10-04: one BDE can govern ICM and ISMIN).

CREATE TABLE IF NOT EXISTS association_audiences (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "associationId" UUID NOT NULL REFERENCES associations (id) ON DELETE CASCADE,
    formation       VARCHAR(16) NULL,
    campus          VARCHAR(32) NULL,
    CONSTRAINT "CHK_association_audiences_formation"
        CHECK (formation IS NULL OR formation IN ('ICM', 'ISMIN', 'FSSS', 'Autre')),
    CONSTRAINT "CHK_association_audiences_campus"
        CHECK (campus IS NULL OR campus IN ('saint-etienne', 'gardanne'))
);
-- A rule appears once per association; COALESCE makes NULL ("any") comparable.
CREATE UNIQUE INDEX IF NOT EXISTS "UQ_association_audiences_rule"
    ON association_audiences ("associationId", COALESCE(formation, ''), COALESCE(campus, ''));

-- A POST CHOOSES ITS OWN VISIBILITY (user, 2026-10-04: there is ONE School that may share with one
-- campus or the other, and TWO MEs - so the author picks per post, not a fixed audience per entity).
-- The association's rules above are its CEILING: what it may address. A post with no row here
-- inherits them; a post with rows is visible to those rules instead, and the server refuses rules
-- outside the ceiling - going beyond it is a nominative grant (D24). Same shape as the entity's
-- rules, so one reader resolves both (6b).
CREATE TABLE IF NOT EXISTS post_audiences (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "postId"    UUID NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
    formation   VARCHAR(16) NULL,
    campus      VARCHAR(32) NULL,
    CONSTRAINT "CHK_post_audiences_formation"
        CHECK (formation IS NULL OR formation IN ('ICM', 'ISMIN', 'FSSS', 'Autre')),
    CONSTRAINT "CHK_post_audiences_campus"
        CHECK (campus IS NULL OR campus IN ('saint-etienne', 'gardanne'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "UQ_post_audiences_rule"
    ON post_audiences ("postId", COALESCE(formation, ''), COALESCE(campus, ''));

-- EVERY PAIR EXISTS FROM THE START (user, 2026-10-04: no "opening" of a space - all the combinations,
-- and each association chooses, at two levels, a whole campus or one formation). Four formations x
-- two campuses, the pairs the CHECKs above allow.
INSERT INTO spaces (formation, campus)
    SELECT f, c FROM unnest(ARRAY['ICM', 'ISMIN', 'FSSS', 'Autre']) AS f
    CROSS JOIN unnest(ARRAY['saint-etienne', 'gardanne']) AS c
    ON CONFLICT (formation, campus) DO NOTHING;

-- Every association that has no rule yet addresses ICM x saint-etienne, as it does today.
INSERT INTO association_audiences ("associationId", formation, campus)
    SELECT a.id, 'ICM', 'saint-etienne' FROM associations a
    WHERE NOT EXISTS (SELECT 1 FROM association_audiences r WHERE r."associationId" = a.id);

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
