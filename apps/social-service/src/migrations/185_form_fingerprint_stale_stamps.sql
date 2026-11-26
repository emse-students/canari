-- Migration 185: the stale-open stamps leave a form's draft fingerprint (docs/wiki/frontend/modules/forms.md,
-- "The question put to a form left open"; the draft fingerprint is `FORM_FINGERPRINT_SQL`,
-- `forms/form-draft-revision.ts`).
--
-- `forms."staleAskedAt"` and `forms."staleKeptAt"` (migration 180) are written by the stale-open job and
-- by the manager's "Garder ouvert" answer, never by an edit. The fingerprint hashed them with the rest
-- of the row, so a stamp written while an edit draft was open made the draft read "the form changed
-- since" (409 `FORM_CHANGED_SINCE_REVISION` at its publication) although no content had. The code now
-- excludes both columns.
--
-- DATA ONLY, no schema change. An open draft takes the NEW fingerprint when its base is the form's
-- fingerprint under the OLD rule at a state the stamps explain: each of the two stamps either as it is
-- now or as it was before it was ever written (NULL), four combinations. A draft whose base differs in
-- any other way - the content did change - is left as it was. Spelt as migrations 164 and 183 spell it.
--
-- Idempotent: once re-based, a draft's base no longer equals an old-rule fingerprint of its form
-- (a second run matches nothing), and where it still does equal one (stamps all NULL, so old = new)
-- the re-write is the same value. Reversible by nothing and needing nothing: the old rule is gone.
-- LOCKS: row locks on `form_drafts` and `forms` only (an UPDATE); no table lock.

BEGIN;

UPDATE form_drafts d
   SET "baseFingerprint" = md5((to_jsonb(f) - ARRAY['id', 'ownerId', 'clientCreateId', 'createdAt', 'updatedAt', 'deletedAt', 'closedAt', 'status', 'imageUrl', 'imageMediaId', 'staleAskedAt', 'staleKeptAt'])::text)
  FROM forms f
 WHERE f.id = d."formId"
   AND d.document IS NOT NULL
   AND d."baseFingerprint" IN (
        md5((to_jsonb(f) - ARRAY['id', 'ownerId', 'clientCreateId', 'createdAt', 'updatedAt', 'deletedAt', 'closedAt', 'status', 'imageUrl', 'imageMediaId'])::text),
        md5(((to_jsonb(f) || jsonb_build_object('staleAskedAt', NULL)) - ARRAY['id', 'ownerId', 'clientCreateId', 'createdAt', 'updatedAt', 'deletedAt', 'closedAt', 'status', 'imageUrl', 'imageMediaId'])::text),
        md5(((to_jsonb(f) || jsonb_build_object('staleKeptAt', NULL)) - ARRAY['id', 'ownerId', 'clientCreateId', 'createdAt', 'updatedAt', 'deletedAt', 'closedAt', 'status', 'imageUrl', 'imageMediaId'])::text),
        md5(((to_jsonb(f) || jsonb_build_object('staleAskedAt', NULL, 'staleKeptAt', NULL)) - ARRAY['id', 'ownerId', 'clientCreateId', 'createdAt', 'updatedAt', 'deletedAt', 'closedAt', 'status', 'imageUrl', 'imageMediaId'])::text)
       );

COMMIT;
