-- canari:hold-for-owner - WP-D1 triggers: the two-level dependency axis, enforced by the database.
-- Migration 131 : a governing parent is a BDE, a BDE has no parent, an institution has neither (D2).
--
-- docs/wiki/spaces-and-audiences-reform.md 2.2. A CHECK cannot read another row, so the rule is ONE
-- function and two triggers; the service asks the same rules first (`spaces/dependency-rules.ts`), so
-- a refusal reaches a client as a typed 409, and these are what keep a hand-written UPDATE from
-- breaking it. Each refusal is SQLSTATE 23514 (check_violation) with its stable code in the
-- CONSTRAINT field - never in a message a caller would have to parse:
--   DEPENDENCY_INSTITUTION        an institution given a parent
--   DEPENDENCY_CHILD_IS_A_BDE     a space governor given a parent, or a parented association
--                                 designated as a space governor
--   DEPENDENCY_PARENT_NOT_A_BDE   a parent that is not an association governing at least one space,
--                                 or a parent whose type changes away from 'association'
-- Two levels follow: a parent is a BDE, a BDE has no parent, so no chain is longer than one.
-- Removing a BDE's last space while it has children is NOT refused (a redesignation must stay
-- possible): the service logs it and the Dependencies panel shows the mismatch.
--
-- THE GUARD (2.7, "refused while the count is above zero"): before any trigger exists, every existing
-- row is judged by the SAME function, and the migration RAISES with the count if one fails. Migration
-- 130 corrects every row the validated list names, so on production this reads zero after it.
--
-- Concurrency: both triggers take ONE transaction-scoped advisory lock before reading, so a parent
-- write and a governor designation cannot each pass on a snapshot that misses the other.
--
-- Idempotent for CD: CREATE OR REPLACE, and DROP TRIGGER IF EXISTS before each CREATE TRIGGER.
-- LOCKS: SHARE ROW EXCLUSIVE on `associations` and `spaces` for each CREATE TRIGGER, released at
-- COMMIT; it gives up after 5 s rather than queue (the re-run is safe).

SET lock_timeout = '5s';

BEGIN;

-- The one judgement: NULL when (child of type p_child_type, governing a space or not, with parent
-- p_parent) is allowed, the refusal code otherwise.
CREATE OR REPLACE FUNCTION canari_dependency_refusal(p_child uuid, p_child_type text, p_parent uuid)
RETURNS text LANGUAGE sql STABLE AS $fn$
  SELECT CASE
    WHEN p_parent IS NULL THEN NULL
    WHEN p_child_type = 'institution' THEN 'DEPENDENCY_INSTITUTION'
    WHEN EXISTS (SELECT 1 FROM spaces s WHERE s."bdeAssociationId" = p_child) THEN 'DEPENDENCY_CHILD_IS_A_BDE'
    WHEN NOT EXISTS (SELECT 1 FROM associations p WHERE p.id = p_parent AND p.type = 'association'
                     AND EXISTS (SELECT 1 FROM spaces s WHERE s."bdeAssociationId" = p.id))
      THEN 'DEPENDENCY_PARENT_NOT_A_BDE'
  END
$fn$;

DO $guard$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count FROM associations a
    WHERE canari_dependency_refusal(a.id, a.type, a."parentAssociationId") IS NOT NULL;
  IF v_count > 0 THEN
    RAISE EXCEPTION 'migration 131: % association(s) break the dependency rules - apply migration 130 (the validated parents list) first; nothing written', v_count;
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION canari_associations_dependency_check() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_code text;
BEGIN
  IF NEW."parentAssociationId" IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('canari_dependency'));
    v_code := canari_dependency_refusal(NEW.id, NEW.type, NEW."parentAssociationId");
    IF v_code IS NOT NULL THEN
      RAISE EXCEPTION 'dependency refused: %', v_code
        USING ERRCODE = 'check_violation', CONSTRAINT = v_code;
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.type IS DISTINCT FROM OLD.type AND NEW.type <> 'association' THEN
    PERFORM pg_advisory_xact_lock(hashtext('canari_dependency'));
    IF EXISTS (SELECT 1 FROM associations c WHERE c."parentAssociationId" = NEW.id) THEN
      RAISE EXCEPTION 'dependency refused: %', 'DEPENDENCY_PARENT_NOT_A_BDE'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'DEPENDENCY_PARENT_NOT_A_BDE';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION canari_spaces_dependency_check() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW."bdeAssociationId" IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('canari_dependency'));
    IF EXISTS (SELECT 1 FROM associations a WHERE a.id = NEW."bdeAssociationId"
               AND a."parentAssociationId" IS NOT NULL) THEN
      RAISE EXCEPTION 'dependency refused: %', 'DEPENDENCY_CHILD_IS_A_BDE'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'DEPENDENCY_CHILD_IS_A_BDE';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS trg_associations_dependency ON associations;
CREATE TRIGGER trg_associations_dependency
  BEFORE INSERT OR UPDATE OF "parentAssociationId", type ON associations
  FOR EACH ROW EXECUTE FUNCTION canari_associations_dependency_check();

DROP TRIGGER IF EXISTS trg_spaces_dependency ON spaces;
CREATE TRIGGER trg_spaces_dependency
  BEFORE INSERT OR UPDATE OF "bdeAssociationId" ON spaces
  FOR EACH ROW EXECUTE FUNCTION canari_spaces_dependency_check();

COMMIT;
