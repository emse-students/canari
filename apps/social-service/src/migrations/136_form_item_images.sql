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
-- NO BACKFILL, deliberately. Before this migration `imageUrl` took any string, so a stored value of
-- the public shape names an object whose ORIGIN nothing recorded: it may be an association logo, a
-- form banner or a community image pasted into a question. A row here is a licence to DELETE that
-- object once no form cites it, so a row is written only by the upload route, for the id it has just
-- minted. A form already citing such a value (production, read 2026-11-06: none) is refused on its
-- next save (`QUESTION_IMAGE_NOT_YOURS`) until the question's image is removed and uploaded again.
--
-- ADDITIVE: a new table and two indexes. Idempotent for CD: IF NOT EXISTS. `forms` is not touched.
-- LOCKS: CREATE TABLE and its indexes lock only the new table; the migration gives up after 5 s
-- rather than queue.

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

COMMIT;
