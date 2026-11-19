-- canari:hold-for-owner - a BACKFILL: every stored priced grid's "Obligatoire" switch is turned off.
-- Migration 164 : each priced grid (`product_grid`) gets its own "Obligatoire" switch, OFF by
-- default (owner, 2026-11-13).
--
-- docs/wiki/frontend/modules/forms.md, "Each grid has its own Obligatoire switch". Until this
-- release a grid's `required` was STORED `true` and meant nothing (the save refused anything else,
-- `PRODUCT_GRID_NOT_REQUIRED`); what was required was the ORDER, one unit across the visible grids.
-- That global rule is gone, and the submit now honours each grid's own flag. Every grid stored
-- before this file holds `true`, so honouring it as it stands would make a merch form of four
-- articles demand one of EVERY article - the defect of 2026-11-06. So every stored grid is set
-- `required: false`, the switch's default; a manager who wants a grid demanded turns it on.
--
-- WHAT IT TOUCHES: `forms.items`, a jsonb array of questions. Each element whose `type` is
-- `product_grid` and whose `required` is not already `false` gets `"required": false`; every other
-- element, every other key and the order of the array are kept. Only forms holding such a grid are
-- written. The unpublished revisions (`form_drafts.document`) are NOT rewritten: a document written
-- by an editor without the switch carries no `gridRequiredSwitch`, and both the editor that opens it
-- and the save that publishes it take each grid's flag from the form as stored
-- (`productGridRequiredOnSave`) - which this file has just turned off.
--
-- THE REVISIONS FOLLOW: an open revision built on the form as it stood (its `baseFingerprint` equal
-- to the form's, the `FORM_FINGERPRINT_SQL` of `forms/form-draft-revision.ts`, spelt the same way
-- here) takes the rewritten form as its base, in the same statement - this backfill is no edit made
-- "outside" the revision, and must not make its publication ask "the form changed since" (409
-- `FORM_CHANGED_SINCE_REVISION`). A revision whose base had already moved is left as it was.
--
-- ONE STATEMENT: the CTEs read one snapshot, so `at_base` compares against the forms BEFORE the
-- rewrite, and the last UPDATE fingerprints the rows `updated` RETURNS, the forms AFTER it.
--
-- Idempotent for CD: a second run finds no grid whose `required` is not `false`, and writes
-- nothing. LOCKS: row locks on the forms holding a grid (a few dozen rows), released at COMMIT; a
-- concurrent edit of one of them waits for it, and gives up after 5 s rather than queue (the re-run
-- is safe). No personal data is read or written.
--
-- ROLLBACK: an image older than this file reads a grid's flag only at save, where it refuses
-- `false` (`PRODUCT_GRID_NOT_REQUIRED`). Rolling the image back therefore needs the inverse first,
-- which loses only the switches managers turned on since (proven in
-- `product-grid-required.integration.spec.ts`):
--   UPDATE forms f SET items = (SELECT jsonb_agg(CASE WHEN e.item ->> 'type' = 'product_grid'
--       THEN jsonb_set(e.item, '{required}', 'true'::jsonb) ELSE e.item END ORDER BY e.ord)
--       FROM jsonb_array_elements(f.items) WITH ORDINALITY AS e(item, ord))
--    WHERE jsonb_typeof(f.items) = 'array' AND EXISTS (SELECT 1 FROM jsonb_array_elements(f.items)
--       AS i(item) WHERE i.item ->> 'type' = 'product_grid');

SET lock_timeout = '5s';

WITH targets AS (
  SELECT f.id
    FROM forms f
   WHERE jsonb_typeof(f.items) = 'array'
     AND EXISTS (
       SELECT 1 FROM jsonb_array_elements(f.items) AS i(item)
        WHERE i.item ->> 'type' = 'product_grid'
          AND i.item -> 'required' IS DISTINCT FROM 'false'::jsonb
     )
), at_base AS (
  SELECT d."formId"
    FROM form_drafts d
    JOIN forms f ON f.id = d."formId"
   WHERE d."formId" IN (SELECT id FROM targets)
     AND d.document IS NOT NULL
     AND d."baseFingerprint" = md5((to_jsonb(f) - ARRAY['id', 'ownerId', 'clientCreateId', 'createdAt', 'updatedAt', 'deletedAt', 'closedAt', 'status', 'imageUrl', 'imageMediaId'])::text)
), updated AS (
  UPDATE forms f
     SET items = (
       SELECT jsonb_agg(
                CASE WHEN e.item ->> 'type' = 'product_grid'
                     THEN jsonb_set(e.item, '{required}', 'false'::jsonb)
                     ELSE e.item END
                ORDER BY e.ord)
         FROM jsonb_array_elements(f.items) WITH ORDINALITY AS e(item, ord)
     )
   WHERE f.id IN (SELECT id FROM targets)
  RETURNING f.*
)
UPDATE form_drafts d
   SET "baseFingerprint" = md5((to_jsonb(u) - ARRAY['id', 'ownerId', 'clientCreateId', 'createdAt', 'updatedAt', 'deletedAt', 'closedAt', 'status', 'imageUrl', 'imageMediaId'])::text)
  FROM updated u
 WHERE d."formId" = u.id
   AND d."formId" IN (SELECT "formId" FROM at_base);
