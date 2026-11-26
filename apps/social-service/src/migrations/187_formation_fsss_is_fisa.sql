-- canari:hold-for-owner - rewrites stored data: the formation FSSS is respelt FISA (owner, 2026-11-26).
-- Migration 187: the formation FSSS is FISA.
--
-- The owner settled on 2026-11-26 that FSSS and FISA are the same population (the apprentices,
-- "Formation d'Ingenieur Sous statut d'Apprenti") and that its name is FISA; the wiki gloss
-- "formation sous statut salarie" was wrong (docs/wiki/profiles-and-access.md, D4;
-- docs/wiki/backlog.d/p2-the-formation-fsss-is-fisa.md). The code's three lists say FISA from the
-- release that ships this file; every value stored under the old spelling is rewritten HERE, IN
-- PLACE, so no row is recreated and every id survives - a space keeps its id, so its posts, pins,
-- maps and agenda bindings keep pointing at it.
--
-- What it writes, and nothing else:
-- 1. the three formation CHECKs are WIDENED to accept both spellings, so the rewrite can pass;
-- 2. `spaces`, `association_audiences`, `read_grants`: formation FSSS := FISA;
-- 3. `agenda_subscriptions`: formation and the `"selectionKey"` that spells it (`campus|formation|id`),
--    so a holder's calendar link keeps serving the same space;
-- 4. `posts` and `association_calendar_events` `"reachSpaces"` (arrays of `{formation, campus}`): each
--    FSSS element respelt, order kept;
-- 5. `users` (core-service's table, same database): `formation`, and each `cursus` element's
--    formation, order kept. A sign-in re-copies the cursus from MiConnect, so MiConnect's profiles
--    are rewritten BEFORE the deploy that runs this file (the backlog entry gives the order);
-- 6. the criteria a manager saved - `forms` `"priceMatrix"`, `"submitCondition"` and `items` (each
--    question's `showIf`), `association_products` `"priceMatrix"`, `booking_spaces` `audience` and
--    `items` - hold formation values inside buckets and conditions of several shapes. The JSON
--    STRING `"FSSS"` (a whole value, quotes included, never a substring) is respelt `"FISA"` in the
--    text of each such document. Left as FSSS, a price bucket would stop matching the people it
--    priced and they would fall into "everyone else" - a wrong price, in silence;
-- 7. the second BDE of saint-etienne, renamed by 130 "BDE FSSS - Bureau des Élèves", becomes
--    "BDE FISA - Bureau des Élèves" - matched on its slug AND that exact name, so a name an admin
--    changed since is left as they wrote it;
-- 8. the three CHECKs are NARROWED to the new list, which also PROVES the rewrite: a row still
--    saying FSSS fails the ADD CONSTRAINT and rolls the whole file back.
--
-- LEFT ALONE, deliberately: `users_pre_wp3` (a backup table) and `profile_changes` (a history: what
-- an edit said on its day), the answers and identities a submission recorded (a record of what was
-- true when it was given), and free-text messages.
--
-- Read-only count before it runs (each line one number; all of them say what this file rewrites):
--   SELECT count(*) FROM spaces WHERE formation = 'FSSS';
--   SELECT count(*) FROM association_audiences WHERE formation = 'FSSS';
--   SELECT count(*) FROM read_grants WHERE formation = 'FSSS';
--   SELECT count(*) FROM agenda_subscriptions WHERE formation = 'FSSS';
--   SELECT count(*) FROM users WHERE formation = 'FSSS' OR cursus @> '[{"formation": "FSSS"}]';
--   SELECT count(*) FROM posts WHERE "reachSpaces" @> '[{"formation": "FSSS"}]';
--   SELECT count(*) FROM forms WHERE concat("priceMatrix"::text, "submitCondition"::text, items::text) LIKE '%"FSSS"%';
--
-- ONE TRANSACTION, IDEMPOTENT: a re-run widens, finds nothing to rewrite and narrows again.
-- LOCKS: the three ALTERs take ACCESS EXCLUSIVE on `spaces` (10 rows), `association_audiences` and
-- `read_grants` (small tables) for the constraint check alone; the UPDATEs take row locks. It gives
-- up after 5 s rather than queue behind a long transaction (the re-run is safe).
-- ROLLBACK: an older image knows FSSS and not FISA; rolling the code back past this file leaves
-- FISA rows its lists do not name (a FISA reader opens no space until the code is forward again).

SET lock_timeout = '5s';

BEGIN;

-- 1. Widen.
ALTER TABLE spaces DROP CONSTRAINT IF EXISTS "CHK_spaces_formation";
ALTER TABLE spaces ADD CONSTRAINT "CHK_spaces_formation"
    CHECK (formation IN ('ICM', 'ISMIN', 'FSSS', 'FISA', 'PDIS', 'Autre'));
ALTER TABLE association_audiences DROP CONSTRAINT IF EXISTS "CHK_association_audiences_formation";
ALTER TABLE association_audiences ADD CONSTRAINT "CHK_association_audiences_formation"
    CHECK (formation IS NULL OR formation IN ('ICM', 'ISMIN', 'FSSS', 'FISA', 'PDIS', 'Autre'));
-- 078 declared this one inline, unnamed: PostgreSQL named it `read_grants_formation_check`.
ALTER TABLE read_grants DROP CONSTRAINT IF EXISTS read_grants_formation_check;
ALTER TABLE read_grants ADD CONSTRAINT read_grants_formation_check
    CHECK (formation IS NULL OR formation IN ('ICM', 'ISMIN', 'FSSS', 'FISA', 'PDIS', 'Autre'));

-- 2. The three closed columns.
UPDATE spaces SET formation = 'FISA' WHERE formation = 'FSSS';
UPDATE association_audiences SET formation = 'FISA' WHERE formation = 'FSSS';
UPDATE read_grants SET formation = 'FISA' WHERE formation = 'FSSS';

-- 3. A holder's agenda link: the selection and the key that spells it.
UPDATE agenda_subscriptions
    SET formation = 'FISA', "selectionKey" = replace("selectionKey", '|FSSS|', '|FISA|')
    WHERE formation = 'FSSS';

-- 4. The spaces an institution's post or event reaches.
UPDATE posts p SET "reachSpaces" = (
    SELECT jsonb_agg(CASE WHEN t.e ->> 'formation' = 'FSSS'
                          THEN jsonb_set(t.e, '{formation}', '"FISA"') ELSE t.e END ORDER BY t.i)
    FROM jsonb_array_elements(p."reachSpaces") WITH ORDINALITY AS t(e, i))
    WHERE p."reachSpaces" @> '[{"formation": "FSSS"}]';
UPDATE association_calendar_events ev SET "reachSpaces" = (
    SELECT jsonb_agg(CASE WHEN t.e ->> 'formation' = 'FSSS'
                          THEN jsonb_set(t.e, '{formation}', '"FISA"') ELSE t.e END ORDER BY t.i)
    FROM jsonb_array_elements(ev."reachSpaces") WITH ORDINALITY AS t(e, i))
    WHERE ev."reachSpaces" @> '[{"formation": "FSSS"}]';

-- 5. Who a person is: the legacy column and every cursus entry.
UPDATE users SET formation = 'FISA' WHERE formation = 'FSSS';
UPDATE users u SET cursus = (
    SELECT jsonb_agg(CASE WHEN t.e ->> 'formation' = 'FSSS'
                          THEN jsonb_set(t.e, '{formation}', '"FISA"') ELSE t.e END ORDER BY t.i)
    FROM jsonb_array_elements(u.cursus) WITH ORDINALITY AS t(e, i))
    WHERE u.cursus @> '[{"formation": "FSSS"}]';

-- 6. The criteria a manager saved: the whole JSON string "FSSS", never a substring of another.
UPDATE forms SET "priceMatrix" = replace("priceMatrix"::text, '"FSSS"', '"FISA"')::jsonb
    WHERE "priceMatrix"::text LIKE '%"FSSS"%';
UPDATE forms SET "submitCondition" = replace("submitCondition"::text, '"FSSS"', '"FISA"')::jsonb
    WHERE "submitCondition"::text LIKE '%"FSSS"%';
UPDATE forms SET items = replace(items::text, '"FSSS"', '"FISA"')::jsonb
    WHERE items::text LIKE '%"FSSS"%';
UPDATE association_products SET "priceMatrix" = replace("priceMatrix"::text, '"FSSS"', '"FISA"')::jsonb
    WHERE "priceMatrix"::text LIKE '%"FSSS"%';
UPDATE booking_spaces SET audience = replace(audience::text, '"FSSS"', '"FISA"')::jsonb
    WHERE audience::text LIKE '%"FSSS"%';
UPDATE booking_spaces SET items = replace(items::text, '"FSSS"', '"FISA"')::jsonb
    WHERE items::text LIKE '%"FSSS"%';

-- 7. The second BDE of saint-etienne, by slug and the exact name 130 gave it.
UPDATE associations SET name = 'BDE FISA - Bureau des Élèves'
    WHERE slug = 'bde-bureau-des-eleves' AND name = 'BDE FSSS - Bureau des Élèves';

-- 8. Narrow: a row still saying FSSS fails here, and nothing above is kept.
ALTER TABLE spaces DROP CONSTRAINT IF EXISTS "CHK_spaces_formation";
ALTER TABLE spaces ADD CONSTRAINT "CHK_spaces_formation"
    CHECK (formation IN ('ICM', 'ISMIN', 'FISA', 'PDIS', 'Autre'));
ALTER TABLE association_audiences DROP CONSTRAINT IF EXISTS "CHK_association_audiences_formation";
ALTER TABLE association_audiences ADD CONSTRAINT "CHK_association_audiences_formation"
    CHECK (formation IS NULL OR formation IN ('ICM', 'ISMIN', 'FISA', 'PDIS', 'Autre'));
ALTER TABLE read_grants DROP CONSTRAINT IF EXISTS read_grants_formation_check;
ALTER TABLE read_grants ADD CONSTRAINT read_grants_formation_check
    CHECK (formation IS NULL OR formation IN ('ICM', 'ISMIN', 'FISA', 'PDIS', 'Autre'));

COMMIT;
