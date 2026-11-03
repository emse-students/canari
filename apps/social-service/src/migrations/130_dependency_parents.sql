-- canari:hold-for-owner - WP-D1 data: the parents list the owner validated on 2026-11-03, as is.
-- Migration 130 : every existing association and list gets its governing parent BDE (G1-G6).
--
-- docs/wiki/spaces-and-audiences-reform.md 2.7, where the list itself is kept row for row, with
-- names ("The parents list, validated by the owner on 2026-11-03, as is"). The owner may correct a
-- row later in production, from the Dependencies panel (journaled); this file is never edited to do
-- it.
--
-- What it writes, and nothing else:
-- 1. For each of the 74 rows: `"parentAssociationId"` := the new governing parent (the main BDE,
--    slug `bde`), and `"displayParentAssociationId"` := the G3 label (`bds` or `bda`, or none). Each
--    change of a governing parent writes a `dependency_journal` line (`source = 'migration-130'`).
-- 2. G2: the second BDE of saint-etienne (slug `bde-bureau-des-eleves`, FSSS only) is renamed so the
--    two are told apart. Its slug does not move.
-- 3. G4: MINITEL (slug `minitel`) governs the five gardanne spaces. A gardanne space already governed
--    by MINITEL or by nobody is set; one governed by ANY other association stops the migration (not
--    what was validated). Each change writes a `dependency_journal` line (`subject_kind = 'space'`).
--    Its audience is NOT touched: a governor no longer adds rules (2.5, "no silent change").
--
-- RESOLVED BY SLUG, ALL OR NOTHING, NEVER A SILENT SKIP:
-- - every slug named here (children, parents, labels, the renamed BDE, MINITEL) must exist exactly
--   once; if SOME are missing, it RAISES and names them, and nothing is written;
-- - if NONE exists, this is an estate without the production associations (the dev seed, a scratch
--   database): it RAISES A NOTICE saying so and writes nothing;
-- - each row's type must be the validated one, its CURRENT parent must be the validated "from" (or
--   already the "to" - a re-run), it must govern no space, and `bde` must be an association that
--   governs at least one space - otherwise it RAISES naming the slug. So migration 131's guard reads
--   zero after it, by construction.
-- Idempotent: a value already equal is not rewritten, so a re-run writes no row and no journal line.
-- Every change is reported with RAISE NOTICE (slug, from, to), and a final NOTICE gives the counts.
--
-- Read-only count before it runs (the 2.7 count: rows whose governing parent is not a BDE):
--   SELECT count(*) FROM associations a JOIN associations p ON p.id = a."parentAssociationId"
--   WHERE NOT (p.type = 'association' AND EXISTS (SELECT 1 FROM spaces s WHERE s."bdeAssociationId" = p.id));
-- LOCKS: row locks on the associations and spaces rows it rewrites; it gives up after 5 s rather
-- than queue behind a write holding one (the re-run is safe: it is idempotent).

SET lock_timeout = '5s';

BEGIN;

DO $d1$
DECLARE
  -- slug, validated type, current parent slug (NULL = none), new governing parent slug, G3 label slug.
  v_rows text[] := ARRAY[
    ARRAY['califormines-state-university', 'list', 'bds', 'bde', 'bds']::text[],
    ARRAY['cominessariat', 'list', 'bds', 'bde', 'bds']::text[],
    ARRAY['excartlibur', 'list', 'bda', 'bde', 'bda']::text[],
    ARRAY['faucon-minesllenium', 'list', 'bds', 'bde', 'bds']::text[],
    ARRAY['gaulwarts', 'list', 'bda', 'bde', 'bda']::text[],
    ARRAY['hogwarts', 'list', 'bda', 'bde', 'bda']::text[],
    ARRAY['les-tortues-minesja', 'list', 'bds', 'bde', 'bds']::text[],
    ARRAY['martiacartey', 'list', 'bda', 'bde', 'bda']::text[],
    ARRAY['les-trois-minesquetaires', 'list', 'bds', 'bde', 'bds']::text[],
    ARRAY['minesinblack', 'list', 'bds', 'bde', 'bds']::text[],
    ARRAY['minesger-games', 'list', 'bds', 'bde', 'bds']::text[],
    ARRAY['mines-itaires', 'list', 'bds', 'bde', 'bds']::text[],
    ARRAY['minestervilles', 'list', 'bds', 'bde', 'bds']::text[],
    ARRAY['minesvictus', 'list', 'bds', 'bde', 'bds']::text[],
    ARRAY['cartglass', 'list', 'bda', 'bde', 'bda']::text[],
    ARRAY['moulinsart', 'list', 'bda', 'bde', 'bda']::text[],
    ARRAY['fort-boyart', 'list', 'bda', 'bde', 'bda']::text[],
    ARRAY['pixart', 'list', 'bda', 'bde', 'bda']::text[],
    ARRAY['ragminesrk-liste', 'list', 'bds', 'bde', 'bds']::text[],
    ARRAY['mammamiart', 'list', 'bda', 'bde', 'bda']::text[],
    ARRAY['shaomines', 'list', 'bds', 'bde', 'bds']::text[],
    ARRAY['magicartpe', 'list', 'bda', 'bde', 'bda']::text[],
    ARRAY['wondartland', 'list', 'bda', 'bde', 'bda']::text[],
    ARRAY['jurassic-partk', 'list', 'bda', 'bde', 'bda']::text[],
    ARRAY['rockminesbalboa', 'list', 'bds', 'bde', 'bds']::text[],
    ARRAY['brainstormines', 'list', 'bds', 'bde', 'bds']::text[],
    ARRAY['ame', 'association', NULL, 'bde', NULL]::text[],
    ARRAY['bda', 'association', NULL, 'bde', NULL]::text[],
    ARRAY['bdi', 'association', NULL, 'bde', NULL]::text[],
    ARRAY['bds', 'association', NULL, 'bde', NULL]::text[],
    ARRAY['bt-bureau-technique', 'association', NULL, 'bde', NULL]::text[],
    ARRAY['comines-out', 'association', NULL, 'bde', NULL]::text[],
    ARRAY['dopamines', 'association', NULL, 'bde', NULL]::text[],
    ARRAY['emse-finance', 'association', NULL, 'bde', NULL]::text[],
    ARRAY['fablab', 'association', NULL, 'bde', NULL]::text[],
    ARRAY['forum', 'association', NULL, 'bde', NULL]::text[],
    ARRAY['gala-illumines', 'association', NULL, 'bde', NULL]::text[],
    ARRAY['gourmines', 'association', NULL, 'bde', NULL]::text[],
    ARRAY['humani-mines', 'association', NULL, 'bde', NULL]::text[],
    ARRAY['associflard', 'association', NULL, 'bde', NULL]::text[],
    ARRAY['cercle', 'association', NULL, 'bde', NULL]::text[],
    ARRAY['les-rootz', 'association', NULL, 'bde', NULL]::text[],
    ARRAY['mino', 'association', NULL, 'bde', NULL]::text[],
    ARRAY['mtm', 'association', NULL, 'bde', NULL]::text[],
    ARRAY['mitv', 'association', NULL, 'bde', NULL]::text[],
    ARRAY['mines-space', 'association', NULL, 'bde', NULL]::text[],
    ARRAY['mines-ergies', 'association', NULL, 'bde', NULL]::text[],
    ARRAY['mines-ramax', 'association', NULL, 'bde', NULL]::text[],
    ARRAY['mep', 'association', NULL, 'bde', NULL]::text[],
    ARRAY['oenolo-mines', 'association', NULL, 'bde', NULL]::text[],
    ARRAY['pac-mines', 'association', NULL, 'bde', NULL]::text[],
    ARRAY['pist-on-fire', 'association', NULL, 'bde', NULL]::text[],
    ARRAY['respire', 'association', NULL, 'bde', NULL]::text[],
    ARRAY['sto-mines', 'association', NULL, 'bde', NULL]::text[],
    ARRAY['wana', 'association', NULL, 'bde', NULL]::text[],
    ARRAY['womines', 'association', NULL, 'bde', NULL]::text[],
    ARRAY['apocamines', 'list', 'bde', 'bde', NULL]::text[],
    ARRAY['criminesl', 'list', 'bde', 'bde', NULL]::text[],
    ARRAY['fat-liste', 'list', NULL, 'bde', NULL]::text[],
    ARRAY['homineswood', 'list', 'bde', 'bde', NULL]::text[],
    ARRAY['illuminesati', 'list', 'bde', 'bde', NULL]::text[],
    ARRAY['minesception', 'list', 'bde', 'bde', NULL]::text[],
    ARRAY['minesexplor', 'list', 'bde', 'bde', NULL]::text[],
    ARRAY['mineswest', 'list', 'bde', 'bde', NULL]::text[],
    ARRAY['minesvswild', 'list', 'bde', 'bde', NULL]::text[],
    ARRAY['minession-impossible', 'list', 'bde', 'bde', NULL]::text[],
    ARRAY['minestagnard', 'list', 'bde', 'bde', NULL]::text[],
    ARRAY['minestemporel', 'list', 'bde', 'bde', NULL]::text[],
    ARRAY['aminesrica', 'list', 'bde', 'bde', NULL]::text[],
    ARRAY['minesti-verse', 'list', 'bde', 'bde', NULL]::text[],
    ARRAY['minesversal-studios', 'list', 'bde', 'bde', NULL]::text[],
    ARRAY['minesxico', 'list', 'bde', 'bde', NULL]::text[],
    ARRAY['tartiflette', 'list', NULL, 'bde', NULL]::text[],
    ARRAY['minesterpol', 'list', 'bde', 'bde', NULL]::text[]
  ];
  v_row text[];
  v_slugs text[];
  v_missing text[];
  v_present integer;
  v_child associations%ROWTYPE;
  v_bde uuid;
  v_from uuid;
  v_to uuid;
  v_label uuid;
  v_minitel associations%ROWTYPE;
  v_space record;
  v_parents_changed integer := 0;
  v_labels_changed integer := 0;
  v_spaces_changed integer := 0;
  v_renamed integer := 0;
BEGIN
  -- Every slug this file names, once.
  SELECT array_agg(DISTINCT s) INTO v_slugs FROM (
    SELECT v_rows[i][j] AS s FROM generate_subscripts(v_rows, 1) i, generate_subscripts(v_rows, 2) j
    WHERE j IN (1, 3, 4, 5)
    UNION SELECT 'bde-bureau-des-eleves' UNION SELECT 'minitel') named WHERE s IS NOT NULL;

  SELECT count(*), array_agg(n.s) FILTER (WHERE a.id IS NULL)
    INTO v_present, v_missing
    FROM unnest(v_slugs) n(s) LEFT JOIN associations a ON a.slug = n.s;
  v_present := v_present - coalesce(array_length(v_missing, 1), 0);

  IF v_present = 0 THEN
    RAISE NOTICE 'migration 130: none of the % slugs exists - an estate without the production associations (a seed, a scratch database); nothing written', array_length(v_slugs, 1);
    RETURN;
  END IF;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'migration 130: % of % slugs are missing, nothing written: %',
      array_length(v_missing, 1), array_length(v_slugs, 1), array_to_string(v_missing, ', ');
  END IF;
  IF (SELECT count(*) FROM associations WHERE slug = ANY (v_slugs)) <> array_length(v_slugs, 1) THEN
    RAISE EXCEPTION 'migration 130: a slug resolves to more than one association, nothing written';
  END IF;

  SELECT id INTO v_bde FROM associations WHERE slug = 'bde';
  IF NOT EXISTS (SELECT 1 FROM associations p WHERE p.id = v_bde AND p.type = 'association'
                 AND p."parentAssociationId" IS NULL
                 AND EXISTS (SELECT 1 FROM spaces s WHERE s."bdeAssociationId" = p.id)) THEN
    RAISE EXCEPTION 'migration 130: slug bde is not a parentless association governing a space';
  END IF;

  FOREACH v_row SLICE 1 IN ARRAY v_rows LOOP
    SELECT * INTO v_child FROM associations WHERE slug = v_row[1] FOR UPDATE;
    IF v_child.type <> v_row[2] THEN
      RAISE EXCEPTION 'migration 130: % is a %, the validated list says %', v_row[1], v_child.type, v_row[2];
    END IF;
    IF EXISTS (SELECT 1 FROM spaces s WHERE s."bdeAssociationId" = v_child.id) THEN
      RAISE EXCEPTION 'migration 130: % governs a space, so it may have no parent', v_row[1];
    END IF;
    SELECT id INTO v_from FROM associations WHERE slug = v_row[3];
    SELECT id INTO v_to FROM associations WHERE slug = v_row[4];
    SELECT id INTO v_label FROM associations WHERE slug = v_row[5];
    IF v_to IS DISTINCT FROM v_bde THEN
      RAISE EXCEPTION 'migration 130: % names % as parent, only bde is validated', v_row[1], v_row[4];
    END IF;
    IF v_child."parentAssociationId" IS DISTINCT FROM v_from
       AND v_child."parentAssociationId" IS DISTINCT FROM v_to THEN
      RAISE EXCEPTION 'migration 130: % has a parent the validated list did not see (expected %), nothing written',
        v_row[1], coalesce(v_row[3], 'none');
    END IF;
    IF v_child."parentAssociationId" IS DISTINCT FROM v_to THEN
      UPDATE associations SET "parentAssociationId" = v_to WHERE id = v_child.id;
      INSERT INTO dependency_journal (subject_kind, subject_id, from_id, to_id, actor, source)
        VALUES ('entity', v_child.id, v_child."parentAssociationId", v_to, NULL, 'migration-130');
      v_parents_changed := v_parents_changed + 1;
      RAISE NOTICE 'migration 130: % parent % -> %', v_row[1], coalesce(v_row[3], 'none'), v_row[4];
    END IF;
    IF v_child."displayParentAssociationId" IS DISTINCT FROM v_label THEN
      UPDATE associations SET "displayParentAssociationId" = v_label WHERE id = v_child.id;
      v_labels_changed := v_labels_changed + 1;
      RAISE NOTICE 'migration 130: % label -> %', v_row[1], coalesce(v_row[5], 'none');
    END IF;
  END LOOP;

  -- G2: the FSSS BDE of saint-etienne, told apart from the main one.
  UPDATE associations SET name = 'BDE FSSS - Bureau des Élèves'
    WHERE slug = 'bde-bureau-des-eleves' AND name IS DISTINCT FROM 'BDE FSSS - Bureau des Élèves';
  GET DIAGNOSTICS v_renamed = ROW_COUNT;
  IF v_renamed > 0 THEN
    RAISE NOTICE 'migration 130: bde-bureau-des-eleves renamed';
  END IF;

  -- G4: MINITEL governs the five gardanne spaces.
  SELECT * INTO v_minitel FROM associations WHERE slug = 'minitel';
  IF v_minitel.type <> 'association' OR v_minitel."parentAssociationId" IS NOT NULL THEN
    RAISE EXCEPTION 'migration 130: minitel must be a parentless association to govern a space';
  END IF;
  FOR v_space IN SELECT id, formation, "bdeAssociationId" FROM spaces
                 WHERE campus = 'gardanne' ORDER BY formation FOR UPDATE LOOP
    IF v_space."bdeAssociationId" IS NOT NULL AND v_space."bdeAssociationId" <> v_minitel.id THEN
      RAISE EXCEPTION 'migration 130: gardanne % is governed by another association, nothing written',
        v_space.formation;
    END IF;
    IF v_space."bdeAssociationId" IS NULL THEN
      UPDATE spaces SET "bdeAssociationId" = v_minitel.id WHERE id = v_space.id;
      INSERT INTO dependency_journal (subject_kind, subject_id, from_id, to_id, actor, source)
        VALUES ('space', v_space.id, NULL, v_minitel.id, NULL, 'migration-130');
      v_spaces_changed := v_spaces_changed + 1;
      RAISE NOTICE 'migration 130: gardanne % governed by minitel', v_space.formation;
    END IF;
  END LOOP;

  RAISE NOTICE 'migration 130: % parent(s), % label(s), % space governor(s) changed, % rename',
    v_parents_changed, v_labels_changed, v_spaces_changed, v_renamed;
END
$d1$;

COMMIT;
