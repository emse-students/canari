-- canari:hold-for-owner - a BACKFILL: every carte gets a space, zones of its own and one switch per association; a live carte that cannot be attached to one space goes offline.
-- Migration 147: a "Carte de la Vie Asso" belongs to ONE space (owner, 2026-11-08).
--
-- docs/wiki/carte-vie-asso.md, "A carte belongs to one space". What changes:
--
-- 1. `poster_projects."spaceId"` names the space (a formation x campus pair) the map is drawn for.
--    The BDE governing that space manages it; the platform admin manages every map.
-- 2. `poster_zones`: the zones are the MAP's, no longer the platform's. Every existing map receives
--    a copy of every row of `association_categories`, with the same label and order. The copy's id
--    is derived from (map, category), so a re-run inserts nothing twice.
-- 3. `poster_entries`: one row per (map, association) the map has SEEN - its switch and its zone.
--    An association of the space with no row is NEW: it arrives switched off, with a badge.
--    Seeded for every attached map, for every association its saved layout PLACED: ON when the
--    association is of the map's space, OFF when it is not (never deleted - its placement stays in
--    the layout). An association of the space the layout never placed gets no row, so the editor
--    offers it as new. The zone is the association's per-bubble `categoryOverride` (a category
--    slug, when a layout carries one), else its `categoryId`.
-- 4. AT MOST ONE LIVE MAP PER SPACE: the partial unique index of migration 035 (one live map for
--    the whole platform) is replaced by one on ("spaceId") among published rows, and a CHECK refuses
--    a live map with no space - a NULL would be distinct from every other in a unique index.
--
-- WHICH SPACE AN EXISTING MAP GETS. The live map is attached to the ICM space governed by the
-- association of slug `bde` (type `association`) - the owner's decision for the map that was live
-- on 2026-11-08 - when that resolves to exactly ONE space and exactly one map is live. Any other
-- map is attached to the single space governed by the BDEs in which its creator holds MANAGE_ASSO
-- (bit 64), when that is exactly one space. Everything else is left with no space: a live one is
-- taken OFFLINE (the CHECK above refuses it live) and a NOTICE says how many; the platform admin
-- attaches it from the editor, which seeds its switches then.
--
-- The tables `association_categories` and the column `associations."categoryId"` are left in place:
-- no code reads them after this release, and they are dropped by a LATER migration once
-- `prod-released` contains the commit that unmapped them (an image older than that maps the column
-- in every INSERT INTO associations; docs/wiki/backlog.d/drop-the-global-association-categories.md).
--
-- Idempotent for CD: IF NOT EXISTS on every column, table, index and constraint (the constraints
-- through a catalogue check), ids derived from their inputs with ON CONFLICT DO NOTHING, and updates
-- that match only rows still unattached. Constraints are added NOT VALID then validated.
-- LOCKS: ACCESS EXCLUSIVE on `poster_projects` (a handful of rows) for the column, the constraints
-- and the index swap; SHARE ROW EXCLUSIVE on `spaces` and `associations` for the foreign keys of
-- the new tables - a catalogue change, no scan of them. Gives up after 5 s rather than queue; a
-- re-run is safe.
--
-- ROLLBACK WINDOW: an image older than this migration still serving during the rolling deploy
-- publishes by clearing EVERY live row, which unpublishes the other spaces' maps for that one
-- request, and its publish of an unattached map is refused by the CHECK (a 500 on an admin's
-- button, during the window only).

SET lock_timeout = '5s';

BEGIN;

ALTER TABLE poster_projects ADD COLUMN IF NOT EXISTS "spaceId" uuid;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'poster_projects_space_fk' AND conrelid = 'poster_projects'::regclass) THEN
    ALTER TABLE poster_projects ADD CONSTRAINT poster_projects_space_fk
      FOREIGN KEY ("spaceId") REFERENCES spaces (id) ON DELETE RESTRICT NOT VALID;
  END IF;
END $$;

ALTER TABLE poster_projects VALIDATE CONSTRAINT poster_projects_space_fk;

CREATE TABLE IF NOT EXISTS poster_zones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "posterProjectId" uuid NOT NULL REFERENCES poster_projects (id) ON DELETE CASCADE,
  label varchar(120) NOT NULL,
  "sortOrder" integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_poster_zones_project ON poster_zones ("posterProjectId", "sortOrder");

CREATE TABLE IF NOT EXISTS poster_entries (
  "posterProjectId" uuid NOT NULL REFERENCES poster_projects (id) ON DELETE CASCADE,
  "associationId" uuid NOT NULL REFERENCES associations (id) ON DELETE CASCADE,
  enabled boolean NOT NULL,
  "zoneId" uuid REFERENCES poster_zones (id) ON DELETE SET NULL,
  PRIMARY KEY ("posterProjectId", "associationId")
);

CREATE INDEX IF NOT EXISTS idx_poster_entries_zone ON poster_entries ("zoneId");

-- 2. Every map's own copy of the platform's zones.
INSERT INTO poster_zones (id, "posterProjectId", label, "sortOrder")
SELECT md5(p.id::text || ':' || c.id::text)::uuid, p.id, left(c.label, 120), c."sortOrder"
FROM poster_projects p
CROSS JOIN association_categories c
ON CONFLICT (id) DO NOTHING;

-- 1a. The live map: the ICM space of the `bde` association, when it is one space and one live map.
WITH target AS (
  SELECT s.id
  FROM spaces s
  JOIN associations g ON g.id = s."bdeAssociationId"
  WHERE s.formation = 'ICM' AND g.slug = 'bde' AND g.type = 'association'
)
UPDATE poster_projects p
SET "spaceId" = (SELECT target.id FROM target)
WHERE p."spaceId" IS NULL
  AND p.publication IS NOT NULL
  AND (SELECT count(*) FROM target) = 1
  AND (SELECT count(*) FROM poster_projects live WHERE live.publication IS NOT NULL) = 1;

-- 1b. Every other map: the one space its creator's BDEs govern, when there is exactly one.
UPDATE poster_projects p
SET "spaceId" = sole.space_id
FROM (
  SELECT p2.id AS project_id, (array_agg(DISTINCT s.id))[1] AS space_id, count(DISTINCT s.id) AS n
  FROM poster_projects p2
  JOIN association_members m ON m."userId" = p2."createdBy" AND (m.permissions & 64) <> 0
  JOIN associations g ON g.id = m."associationId" AND g.type = 'association'
  JOIN spaces s ON s."bdeAssociationId" = g.id
  WHERE p2."spaceId" IS NULL AND p2.publication IS NULL
  GROUP BY p2.id
) sole
WHERE p.id = sole.project_id AND sole.n = 1;

-- A live map left without a space goes offline: the CHECK below refuses it live.
DO $$
DECLARE
  offline integer;
  unattached integer;
BEGIN
  UPDATE poster_projects
  SET publication = NULL, "publishedAt" = NULL, "publicationFingerprint" = NULL
  WHERE publication IS NOT NULL AND "spaceId" IS NULL;
  GET DIAGNOSTICS offline = ROW_COUNT;
  SELECT count(*) INTO unattached FROM poster_projects WHERE "spaceId" IS NULL;
  IF offline > 0 THEN
    RAISE NOTICE 'migration 147: % live carte(s) resolved to no single space and were taken offline - attach and republish from the editor', offline;
  END IF;
  IF unattached > 0 THEN
    RAISE NOTICE 'migration 147: % carte(s) left with no space - visible to the platform admin only until attached', unattached;
  END IF;
END $$;

-- 3. The switches of every attached map.
INSERT INTO poster_entries ("posterProjectId", "associationId", enabled, "zoneId")
SELECT
  p.id,
  a.id,
  in_space.hit,
  (
    SELECT md5(p.id::text || ':' || c.id::text)::uuid
    FROM association_categories c
    WHERE c.id = COALESCE(
      (
        SELECT oc.id
        FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(p.layout -> 'bubbles') = 'array' THEN p.layout -> 'bubbles' ELSE '[]'::jsonb END
        ) b
        JOIN association_categories oc ON oc.slug = b ->> 'categoryOverride'
        WHERE b ->> 'assoId' = a.id::text
        LIMIT 1
      ),
      a."categoryId"
    )
  )
FROM poster_projects p
JOIN spaces s ON s.id = p."spaceId"
CROSS JOIN associations a
CROSS JOIN LATERAL (
  SELECT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(p.layout -> 'bubbles') = 'array' THEN p.layout -> 'bubbles' ELSE '[]'::jsonb END
    ) b
    WHERE b ->> 'assoId' = a.id::text
  ) AS hit
) placed
CROSS JOIN LATERAL (
  SELECT a.type = 'association' AND NOT a.archived AND EXISTS (
    SELECT 1
    FROM association_audiences r
    WHERE r."associationId" = a.id
      AND (r.formation IS NULL OR r.formation = s.formation)
      AND (r.campus IS NULL OR r.campus = s.campus)
  ) AS hit
) in_space
WHERE placed.hit
ON CONFLICT ("posterProjectId", "associationId") DO NOTHING;

-- 3b. The LIVE document stops showing what step 3 switched off (owner, 2026-11-08: they are off
-- the portail now, not at the next republish). Only units and directory lines whose association
-- has an OFF switch on that map are removed - nothing else in the document is touched. The stored
-- fingerprint no longer describes the document, so it is cleared: the editor then reads the live
-- map as "unknown" instead of claiming it matches. Idempotent: a re-run finds no OFF association
-- left in the document and updates nothing.
UPDATE poster_projects p
SET publication = jsonb_set(
      p.publication,
      '{units}',
      COALESCE(
        (
          SELECT jsonb_agg(u.value ORDER BY u.ordinality)
          FROM jsonb_array_elements(p.publication -> 'units') WITH ORDINALITY u
          WHERE NOT EXISTS (
            SELECT 1 FROM poster_entries e
            WHERE e."posterProjectId" = p.id AND NOT e.enabled
              AND e."associationId"::text = u.value ->> 'assoId'
          )
        ),
        '[]'::jsonb
      )
    ),
    "publicationFingerprint" = NULL
WHERE p.publication IS NOT NULL
  AND jsonb_typeof(p.publication -> 'units') = 'array'
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p.publication -> 'units') u
    JOIN poster_entries e
      ON e."posterProjectId" = p.id AND NOT e.enabled AND e."associationId"::text = u ->> 'assoId'
  );

UPDATE poster_projects p
SET publication = jsonb_set(
      p.publication,
      '{directory,zones}',
      (
        SELECT COALESCE(jsonb_agg(
          jsonb_set(
            z.value,
            '{assos}',
            COALESCE(
              (
                SELECT jsonb_agg(a.value ORDER BY a.ordinality)
                FROM jsonb_array_elements(
                  CASE WHEN jsonb_typeof(z.value -> 'assos') = 'array' THEN z.value -> 'assos' ELSE '[]'::jsonb END
                ) WITH ORDINALITY a
                WHERE NOT EXISTS (
                  SELECT 1 FROM poster_entries e
                  WHERE e."posterProjectId" = p.id AND NOT e.enabled
                    AND e."associationId"::text = a.value ->> 'assoId'
                )
              ),
              '[]'::jsonb
            )
          )
          ORDER BY z.ordinality
        ), '[]'::jsonb)
        FROM jsonb_array_elements(p.publication -> 'directory' -> 'zones') WITH ORDINALITY z
        WHERE jsonb_typeof(z.value) = 'object'
      )
    ),
    "publicationFingerprint" = NULL
WHERE p.publication IS NOT NULL
  AND jsonb_typeof(p.publication -> 'directory' -> 'zones') = 'array'
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p.publication -> 'directory' -> 'zones') z
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(z -> 'assos') = 'array' THEN z -> 'assos' ELSE '[]'::jsonb END
    ) a
    JOIN poster_entries e
      ON e."posterProjectId" = p.id AND NOT e.enabled AND e."associationId"::text = a ->> 'assoId'
  );

-- 4. One live map per space.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'poster_projects_live_has_space' AND conrelid = 'poster_projects'::regclass) THEN
    ALTER TABLE poster_projects ADD CONSTRAINT poster_projects_live_has_space
      CHECK (publication IS NULL OR "spaceId" IS NOT NULL) NOT VALID;
  END IF;
END $$;

ALTER TABLE poster_projects VALIDATE CONSTRAINT poster_projects_live_has_space;

CREATE UNIQUE INDEX IF NOT EXISTS idx_poster_projects_live_per_space
  ON poster_projects ("spaceId")
  WHERE publication IS NOT NULL;

DROP INDEX IF EXISTS idx_poster_projects_single_publication;

COMMIT;
