## P2 - The Alumni merge, Canari side: completed by MiConnect's push, the subjects captured, the manual merge, the sibling jobs

target: 1.8.3

The design is D52-D58 in [profiles-and-access](../profiles-and-access.md#the-alumni-merge-extended-d52-d58-planned-for-183)
([decisions](../decisions/owner-decisions-of-2026-11-26-alumni.md)). Nothing built. In `core-service`
(`AlumniMergeService`, `alumni-merge.controller`) and `frontend/src/routes/admin/alumni-duplicates`.

What it builds:

- **Migration core**: `alumni_merges` gains `mode` (`auto` | `manual`), `reason`, `duplicateSubject`,
  `targetSubject`, `completedBy` (`push` | `reconciler`); a new table `alumni_merge_site_jobs` (one row
  per merge and site, unique index), erased with its merge under the existing rules
  ([register](../compliance/register-of-processing.md), M1). Both entities, so a `synchronize` stack has them.
- **The subjects (D54)**: `merge` stores both accounts' `uid` from the editor API; an open row with no
  subject is backfilled at its next reading while the duplicate exists.
- **The push (D54)**: `POST /api/hooks/miconnect/alumni-merge`, the shared secret
  `MICONNECT_ALUMNI_MERGE_WEBHOOK_SECRET` (constant-time, added to `infrastructure/MIGRATION.md`), runs
  `complete` for the one open row of that duplicate; completes only when the duplicate is gone and the
  target holds the Alumni link of its `af_id`, else `409 ALUMNI_MERGE_NOT_MERGED` at error; a closed
  or unknown row answers `200 { already: true }`. The edge routes that one path to core-service.
- **The reconciler (D54)**: the page read keeps calling `complete`; a row it closes is `completedBy =
  reconciler` and logs `[ALUMNI_MERGE] completed by the reconciler, not the push` at warning.
- **The site jobs (D54)**: `complete` writes the three jobs in the transaction that closes the row; the
  worker is the account-erasure queue's, factorized (one claim/backoff/report implementation, two job
  kinds); the call is a 60 s ES256 `canari-merge+jwt` signed with the handoff key; `2xx` completes,
  a typed `409` blocks (error, no retry), anything else retries. The daily report and the admin page
  show pending and blocked jobs.
- **The manual merge (D55)**: `{ targetUuid, reason }`, the mode decided by the server, the reason
  required for `manual` (20-1000 characters, `ALUMNI_MERGE_REASON_REQUIRED`), `ALUMNI_MERGE_TARGET_BUSY`
  for both modes, the four new mark keys; the admin page's "Rattacher à un autre compte" with its
  eligible-target search and the reason field, every string in `messages/fr.json` and `en.json`
  (`admin_alumni_manual_*`).
- **The one-off repair**: the merge completed before `1.8.3` gets its three jobs written by hand from
  the subject in the private operations notes, under [the four conditions](../decisions/owner-decisions-of-2026-11-18.md).

The tests that prove it:

- `alumni-merge.service.spec.ts`: subjects stored at the mark and backfilled; the push completes a
  merged row (`completedBy = push`, three jobs written, the erasure requested) and refuses a duplicate
  still present, a target without the Alumni link, a wrong secret (401, nothing read); a replayed push
  is a no-op; the reconciler completes with `completedBy = reconciler` and the warning; manual: the
  reason required, too short, too long, the target busy, every D55 guard refused in both modes.
- `alumni-merge-site-jobs.spec.ts` (and the factorized queue's spec): one job per site, a `409` blocks
  without retry, a transport failure retries with backoff, the report names a job pending over 24 h.
- `alumni-merge-hook.e2e-spec.ts`: the route through the edge with and without the secret.
- Frontend vitest for the manual form (reason counter, disabled until valid) and Paraglide keys present
  in both locales (`messages-parity`).
