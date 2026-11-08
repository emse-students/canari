-- Migration 146: the unpublished revision of a form, saved as the manager types (owner, 2026-11-08).
--
-- docs/wiki/frontend/modules/forms.md, "Edits are saved as they are typed, and published together".
-- One row per form at most. `document` is the editor's whole payload (the body a PATCH /forms/:id
-- would carry), stored AS TYPED - a half-built form included - and judged by the edit's own rules
-- only when it is published, which applies it to `forms` in one transaction and empties it.
--
-- `revision` is the compare-and-set counter: every save names the revision it was built on and is
-- refused `409 FORM_DRAFT_CONFLICT` when another save, a publication or a discard moved it first.
-- It ONLY GROWS: a publication or a discard empties `document` (NULL) and bumps it, rather than
-- deleting the row, so an editor still holding the old number cannot start a fresh revision on top
-- of content that is no longer the form's.
--
-- `saveId` is the id the client minted for the save that wrote the current revision: a client whose
-- response was lost re-sends on the old base, is refused 409, and finds ITS OWN id in the refusal -
-- the save landed, and it adopts the revision instead of reporting a conflict (idempotence from the
-- row, never from a clock).
--
-- `recentSaveIds` is the last 32 save ids that wrote the revision, kept across a publication or a
-- discard: the ANCESTRY a device copy is judged against. A copy whose own save is in it landed, even
-- when another writer built on it since - nothing of it is lost, and it is cleared without telling
-- the member it was. Bounded (32 uuids, about 0.5 KB a row).
--
-- `baseFingerprint` is the md5 of the form's own content (`forms` minus its ids, dates, status and
-- cover image) at the moment the revision STARTED. Publication compares it with the form as it is
-- now and refuses `409 FORM_CHANGED_SINCE_REVISION` when something else wrote the form meanwhile
-- (an older build editing it directly), unless the manager confirms the overwrite.
--
-- `forms."clientCreateId"` is the idempotency key of a create: the client mints it, and a second
-- create carrying it for the same owner answers the stored form instead of storing another (a create
-- whose answer was lost). It is NEVER the form's id - the server mints that - so a client cannot
-- choose the id of a form deleted earlier, which posts, links and QR codes may still name. Unique per
-- owner (the index), absent on every form made before it. The column is a nullable ADD COLUMN with
-- no default (catalog only, no rewrite). The unique index is built NON-concurrently, in its own
-- statement (the runner pipes this file without `-1`, so each statement commits on its own): it
-- holds a SHARE lock on `forms` (reads go on, writes wait) for the build, and the build is harmless at this size - one row per form, every key NULL until a client
-- sends one, and the index is partial (`WHERE "clientCreateId" IS NOT NULL`), so it starts empty.
--
-- No personal data beyond what `forms` already holds: the document is the form's own content, and
-- no author column is kept.
--
-- ADDITIVE: a new table and a new nullable column with its index; no existing value is touched. Idempotent for CD (IF NOT EXISTS).

SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS form_drafts (
  "formId" uuid PRIMARY KEY REFERENCES forms(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision >= 1),
  document jsonb,
  "savedAt" timestamptz NOT NULL DEFAULT now(),
  "saveId" uuid,
  "baseFingerprint" text,
  "recentSaveIds" uuid[] NOT NULL DEFAULT '{}'
);

-- A table created by an earlier cut of this migration (on a dev estate) lacks the ancestry: added
-- here, so a second run converges whatever the first one made.
ALTER TABLE form_drafts ADD COLUMN IF NOT EXISTS "recentSaveIds" uuid[] NOT NULL DEFAULT '{}';

ALTER TABLE forms ADD COLUMN IF NOT EXISTS "clientCreateId" uuid;

CREATE UNIQUE INDEX IF NOT EXISTS forms_owner_client_create_id
  ON forms ("ownerId", "clientCreateId") WHERE "clientCreateId" IS NOT NULL;
