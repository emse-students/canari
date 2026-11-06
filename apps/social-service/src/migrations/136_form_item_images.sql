-- Migration 136: the images a form's questions show, and who may cite them (2026-11-06).
--
-- See docs/wiki/frontend/modules/forms.md ("A question's image").
--
-- A question's image is a PUBLIC asset at the media service (`GET /api/media/public/<id>`, no session,
-- so a guest on a public form reads it), cited from `forms.items[].imageUrl`. Until now nothing
-- recorded which public assets were question images: a replaced or removed one stayed stored for
-- ever, and the URL field took any string. One row here per question image:
-- - "formId" NULL: uploaded from the create page, before the form exists - citable only by its
--   uploader's next save, which sets "formId" (the claim);
-- - "formId" set: citable by that form's questions, and by no other form's.
--
-- THIS TABLE IS THE ALLOWLIST OF THE RELEASE. `form-item-images.service.ts` deletes a blob only when
-- its id has a row here AND no form's items cite it (re-read under the image's advisory lock), and the
-- media service deletes it only if it is a public asset. A row older than a day that no form cites -
-- an upload abandoned, a form removed, an association deleted - is released by the hourly
-- reconciliation.
--
-- No foreign key on "formId", for form_files' reason (085): a form with no submission is deleted
-- outright (`retireForms`), and its images must stay listed until their blobs are released.
--
-- BACKFILL: every image a stored question already cites in the canonical form the upload route has
-- always answered (`/api/media/public/<uuid>`) gets its row, on the form citing it, the form's owner as
-- uploader (the real one was never recorded). ON CONFLICT keeps the first. A value of any other shape
-- gets no row: the DTO now refuses it, so the form's next save must drop it.
--
-- ADDITIVE: a new table, two indexes, an INSERT ... SELECT. Idempotent for CD: IF NOT EXISTS and ON
-- CONFLICT DO NOTHING. `forms` is only read. LOCKS: CREATE TABLE and its indexes lock only the new
-- table; the migration gives up after 5 s rather than queue.

SET lock_timeout = '5s';

BEGIN;

CREATE TABLE IF NOT EXISTS form_item_images (
  "mediaId"    uuid         PRIMARY KEY,
  "formId"     uuid         NULL,
  "uploaderId" varchar(255) NOT NULL,
  "createdAt"  timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS form_item_images_form_idx ON form_item_images ("formId");
CREATE INDEX IF NOT EXISTS form_item_images_created_idx ON form_item_images ("createdAt");

INSERT INTO form_item_images ("mediaId", "formId", "uploaderId", "createdAt")
SELECT DISTINCT ON (m.id) m.id::uuid, f.id, f."ownerId", f."createdAt"
FROM forms f
CROSS JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof(f.items) = 'array' THEN f.items ELSE '[]'::jsonb END
) AS it
CROSS JOIN LATERAL (
  SELECT substring(it->>'imageUrl' FROM '^/api/media/public/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$') AS id
) AS m
WHERE m.id IS NOT NULL
ORDER BY m.id, f."createdAt"
ON CONFLICT ("mediaId") DO NOTHING;

COMMIT;
