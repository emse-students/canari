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
-- `baseFingerprint` is the md5 of the form's own content (`forms` minus its ids, dates, status and
-- cover image) at the moment the revision STARTED. Publication compares it with the form as it is
-- now and refuses `409 FORM_CHANGED_SINCE_REVISION` when something else wrote the form meanwhile
-- (an older build editing it directly), unless the manager confirms the overwrite.
--
-- No personal data beyond what `forms` already holds: the document is the form's own content, and
-- no author column is kept.
--
-- ADDITIVE: a new table, nothing existing is touched. Idempotent for CD (IF NOT EXISTS).

SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS form_drafts (
  "formId" uuid PRIMARY KEY REFERENCES forms(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision >= 1),
  document jsonb,
  "savedAt" timestamptz NOT NULL DEFAULT now(),
  "saveId" uuid,
  "baseFingerprint" text
);
