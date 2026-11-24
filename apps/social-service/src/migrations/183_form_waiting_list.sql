-- Migration 183: an OPTIONAL waiting list on a form with a limited number of places (owner, 2026-11-23).
--
-- docs/wiki/frontend/modules/forms.md, "A waiting list on a limited form"; the owner's four choices
-- are in docs/wiki/decisions/owner-decisions-of-2026-11-23.md. With the list on, an answer given
-- once every place is taken is stored as `waiting` instead of refused, and the first in line is
-- registered automatically, under the form's seat lock, the moment a place is freed.
--
-- 1. `forms."waitlistEnabled"`: boolean NOT NULL DEFAULT false - the manager's switch, off on every
--    form (opt-in). A constant default: PostgreSQL 11+ records it in the catalogue, no table rewrite.
-- 2. `submissions."waitlistOrder"`: bigint NULL - the arrival order of a waiting answer, written
--    under the form lock as one more than the form's highest. The rank is counted from it; never a
--    clock. NULL on every answer that never waited.
-- 3. `submissions."promotedAt"`: timestamptz NULL - when a waiting answer became a registration.
-- 4. `submissions."promotionNotifiedAt"`: timestamptz NULL - the claim of the one notice of a
--    promotion: a conditional UPDATE exactly one run wins, cleared again if writing it failed.
-- 5. `submissions_waitlist_idx`: the waiting answers of a form in arrival order (partial, small).
--
-- The status `waiting` (and `payment_due`, a promoted online answer owing its payment) needs no
-- schema: `paymentStatus` is a varchar with no CHECK.
--
-- THE OPEN REVISIONS FOLLOW the new column: `FORM_FINGERPRINT_SQL` (`forms/form-draft-revision.ts`)
-- hashes the whole row, so adding a column moves the fingerprint of every form, and a revision built
-- on the form as it stood would read "the form changed since" at its publication (409
-- `FORM_CHANGED_SINCE_REVISION`). A revision whose base is the form's fingerprint WITHOUT the new
-- column - the form as it stood before this file - takes the fingerprint WITH it. A revision whose
-- base had already moved is left as it was. Spelt as migration 164 spells it.
--
-- ADDITIVE and plain (not held): new columns, a partial index on a small table, and the re-based
-- revision fingerprints (no personal data). Idempotent for CD (IF NOT EXISTS; a second run finds no
-- revision whose base matches the fingerprint without the column). An older container never names
-- the columns; it never writes `waiting`, so it never meets one except in a count, where `waiting`
-- matches no seat-holding status. Reversible: drop the index and the four columns.
-- LOCKS: ACCESS EXCLUSIVE on `forms` and `submissions` for the catalogue changes (no rewrite), a
-- SHARE lock on `submissions` while the index builds (hundreds of rows), row locks on the open
-- revisions; the migration gives up after 5 s rather than queue behind a long transaction.

SET lock_timeout = '5s';

BEGIN;

ALTER TABLE forms ADD COLUMN IF NOT EXISTS "waitlistEnabled" boolean NOT NULL DEFAULT false;

ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "waitlistOrder" bigint NULL;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "promotedAt" timestamptz NULL;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "promotionNotifiedAt" timestamptz NULL;

CREATE INDEX IF NOT EXISTS submissions_waitlist_idx
  ON submissions ("formId", "waitlistOrder")
  WHERE "paymentStatus" = 'waiting';

UPDATE form_drafts d
   SET "baseFingerprint" = md5((to_jsonb(f) - ARRAY['id', 'ownerId', 'clientCreateId', 'createdAt', 'updatedAt', 'deletedAt', 'closedAt', 'status', 'imageUrl', 'imageMediaId'])::text)
  FROM forms f
 WHERE f.id = d."formId"
   AND d.document IS NOT NULL
   AND d."baseFingerprint" = md5((to_jsonb(f) - ARRAY['id', 'ownerId', 'clientCreateId', 'createdAt', 'updatedAt', 'deletedAt', 'closedAt', 'status', 'imageUrl', 'imageMediaId', 'waitlistEnabled'])::text);

COMMIT;
