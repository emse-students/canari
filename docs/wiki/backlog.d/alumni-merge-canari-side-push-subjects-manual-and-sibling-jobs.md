## P2 - The Alumni merge, Canari and MiConnect sides: deployed, the pre-1.8.3 merge repaired, and read

target: 1.8.4

_2026-11-28: moved to 1.8.4 when 1.8.3 shipped._

BUILT in `1.8.3` (D54, D55, D57; "As built" in
[profiles-and-access](../profiles-and-access.md#the-alumni-merge-extended-d52-d58-planned-for-183)):
the subjects stored at the mark and backfilled, MiConnect's push and its endpoint, the reconciler's
warning, the manual merge with its reason, the sibling-site jobs, the merge Event that survives the
duplicate; after the review of 2026-11-27, jobs that never cascade (a target erased meanwhile turns
them into erases), "merged" decided from the target's Alumni link alone, both subjects in the push, the
push dispatched only after the merge commits, an unready site waiting quietly, the reason counted in
code points on both sides, the hook rate-limited. Its tests: `alumni-merge.service.spec.ts`, `alumni-merge-site-jobs.spec.ts`,
`alumni-merge-hook.e2e.spec.ts`, `account-erasure.integration.spec.ts` (against PostgreSQL),
`AlumniManualMerge.svelte.test.ts`, `alumniMerge.test.ts`, and step M of `test-enrollment-flow.py`.

What is still owed, and by whom:

- **The secret, by the lead**: `MICONNECT_ALUMNI_MERGE_WEBHOOK_SECRET`, ONE value, set as the GitHub
  production secret (core-service) and in the MiConnect stack's `.env` (the worker reads it), then the
  worker recreated ([MIGRATION](../../../infrastructure/MIGRATION.md)). Until both hold it, every push
  is refused (401, at error) and the page's reconciler completes the merges, at warning.
- **The one-off repair, by the lead**: the merge completed before `1.8.3` has no subject left in
  MiConnect; its three site jobs are written once, by hand, from the subject the private operations
  notes recovered, under [the four conditions](../decisions/owner-decisions-of-2026-11-18.md).
- **The backfill, by the lead, right after the deploy**: open `/admin/alumni-duplicates` once. The
  merge still waiting from 2026-11-26 has no subject on its row, and its reading stores both while
  the duplicate exists; if the person signs in first, the push carries both subjects and the row
  takes them from it.
- **The reading, in production, by the lead** (dev and production share ONE MiConnect and dev holds
  no editor token, so no merge can be read on dev): at the next Alumni sign-in of a marked duplicate -
  the merge still waiting from 2026-11-26 is one, its pre-1.8.3 mark read as `auto` - ONE
  `custom_alumni_merge` Event whose user is the target, and the row closed `completedBy = push` with
  no reconciler warning in core-service's log. A manual merge is read on the admin page (the search,
  the reason counter, the mode and reason on the open merge). The site jobs stay UNREADY (404) until
  the [Sky](alumni-merge-sky-transfers-then-erases-the-duplicate.md),
  [MiGallery](alumni-merge-migallery-transfers-then-erases-the-duplicate.md) and
  [Le Cercle](alumni-merge-le-cercle-transfers-then-erases-the-duplicate.md) endpoints ship, asked
  again daily; the daily report says ONE warning per such site with its count, never an overdue error.
