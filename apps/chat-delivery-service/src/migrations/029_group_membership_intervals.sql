-- Migration 029: membership INTERVALS for MLS conversation groups (user, 2026-10-14).
--
-- A REMOVE HOLDS AGAINST A LATER RE-ADD: a member removed from a group conversation and added back
-- keeps what preceded their removal and never receives what was sent while they were out.
-- `dm_group_members` cannot answer "when was this person out": a removal hard-deletes its row and a
-- re-add creates a new one. This table keeps one row per stretch of membership; the gaps between a
-- person's rows are the windows every history bundle must withhold (GET mls/groups/:id/exclusions).
-- Design: docs/wiki/protocols/history-reconciliation.md.
--
-- BACKFILL: every CURRENT member gets one open interval starting at their `joinedAt`. Removals that
-- happened before this migration were never recorded anywhere, so they cannot be reconstructed -
-- a person removed before it and re-added after it is treated as a member with no gap.
--
-- Idempotent: CREATE ... IF NOT EXISTS, and the backfill inserts only where no open interval exists
-- (synchronize creates the table in dev; this is for prod).

CREATE TABLE IF NOT EXISTS dm_group_membership_intervals (
    "id"        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "groupId"   UUID NOT NULL,
    "userId"    VARCHAR(255) NOT NULL,
    "joinedAt"  TIMESTAMP NOT NULL DEFAULT now(),
    "leftAt"    TIMESTAMP NULL
);

CREATE INDEX IF NOT EXISTS "IDX_dm_group_membership_intervals_group_user"
    ON dm_group_membership_intervals ("groupId", "userId");

-- At most one OPEN interval per person and group: a second enrolment is a no-op, as it is on
-- dm_group_members.
CREATE UNIQUE INDEX IF NOT EXISTS "UQ_dm_group_membership_intervals_open"
    ON dm_group_membership_intervals ("groupId", "userId")
    WHERE "leftAt" IS NULL;

INSERT INTO dm_group_membership_intervals ("groupId", "userId", "joinedAt", "leftAt")
SELECT gm."groupId", gm."userId", gm."joinedAt", NULL
FROM dm_group_members gm
WHERE NOT EXISTS (
    SELECT 1 FROM dm_group_membership_intervals i
    WHERE i."groupId" = gm."groupId" AND i."userId" = gm."userId" AND i."leftAt" IS NULL
);
