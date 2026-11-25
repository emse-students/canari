## P2 - The stale-open stamps change a form's draft fingerprint, so an open draft reads as changed

target: 1.8.2

_2026-11-25: moved to 1.8.2 when 1.8.1 shipped._

**Found 2026-11-23** while adding `forms.waitlistEnabled` (migration 183). The draft fingerprint
(`FORM_FINGERPRINT_SQL`, `apps/social-service/src/forms/form-draft-revision.ts`) covers every column of
`forms` but its ids, dates, status and cover image, so a column added later is covered by itself. Migration
180 added `staleAskedAt` and `staleKeptAt`, which the stale-open job and the manager's keep-open answer
write on their own ([forms](../frontend/modules/forms.md#the-question-put-to-a-form-left-open-owner-2026-11-21-migration-180)):
each stamp changes the fingerprint of a published form, and an edit draft open on it then reads as based
on a form that changed under it, although no content did.

**The fix.** Add both columns to the fingerprint's exclusions, and re-base in a migration the drafts based
on the form as it stood (as migration 183 does for its own column). An integration spec: a draft open,
the stale-open stamp written, the draft still not reported changed.
