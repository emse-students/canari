-- Migration 031: the Alumni duplicates an admin still has to attach, as a queue (owner, 2026-11-26).
--
-- Every admin queue runs through ONE mechanism (docs/wiki/decisions/owner-decisions-of-2026-11-18.md,
-- item 13): a live count, a push and a bell row to the global admins, the item cleared for every admin
-- once one handles it. The duplicates were the only admin page outside it, because they live at
-- MiConnect and are found by reading it (D47) - so nothing in this database said one existed, and no
-- count, no bell gate could be asked about it.
--
-- `alumni_duplicate_flags` is that memory: ONE row per duplicate (its MiConnect uuid, the only key; no
-- name, no e-mail), written the first time a reading finds it matching an existing account
-- (`AlumniDuplicateQueue`) - at the Canari sign-in that created its account, or when the admin page is
-- read - and the push goes out THEN, once: a row that exists is never announced again.
--   `resolvedAt`   set when a later reading finds the duplicate gone or no longer a candidate (or an
--                  admin said it is not one), cleared when it is found again - unless dismissed.
--   `dismissedAt`  set by the admin action "Pas un doublon": TERMINAL, never cleared, so no later
--                  reading and no later sign-in flags the account again (durable state, not a clock).
--   `announcedAt`  set only AFTER the admins were told (the push and the bell row): a notice that
--                  failed leaves it null, and the next reading tells again - an announcement is never
--                  lost for good by one refused call.
--                 Whether a merge of the duplicate stands (marked, or completed) is `alumni_merges`
--                 (028, 029), read at every count (`alumniDuplicatePendingSql` in social-service's
--                 admin-queue-sql.ts) - so marking a duplicate takes it out of every admin's count and
--                 bell with no write here, and cancelling the mark brings it back.
--
-- social-service reads this table and `alumni_merges` straight out of the shared database, as it
-- reads `profile_correction_requests` (010). No foreign keys, for the same reason: nothing here may
-- block an erasure, and the uuid names an account MiConnect owns.
--
-- ROLLOUT ORDER. A new table nothing names yet: the previous release runs unchanged beside it, and the
-- new code never runs before this file. IDEMPOTENT: the deploy ledger replays a file whose predecessor
-- failed mid-run.

CREATE TABLE IF NOT EXISTS alumni_duplicate_flags (
    "duplicateUuid"  UUID PRIMARY KEY,
    "flaggedAt"      TIMESTAMPTZ NOT NULL DEFAULT now(),
    "resolvedAt"     TIMESTAMPTZ,
    "dismissedAt"    TIMESTAMPTZ,
    "announcedAt"    TIMESTAMPTZ
);
