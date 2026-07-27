-- Migration 012: ordered, replayable MLS commit log (backbone rung-1).
-- Renumbered from 007 (it collided with 007_drop_orphan_columns.sql); the content is unchanged.
--
-- Context: the server linearizes commits (validateCommit: Redis lock + strict
-- baseEpoch == activeEpoch gate). Until this table, commit bytes were stored nowhere indexed by
-- epoch, so a lagging device could not replay the commits it missed and fell back to destructive
-- recovery (forget_group + re-Welcome). Every accepted commit is recorded here, keyed by the epoch
-- it advances (baseEpoch), so a client closes a gap by replaying exactly the missing commits
-- (baseEpoch >= its local epoch).
--
-- A single commit can advance a given epoch (linearization) -> unique index (groupId, baseEpoch).
-- Stores ciphertext only (serialized MLS Commit, base64): no keys, no plaintext.
--
-- Idempotent: CREATE TABLE / INDEX IF NOT EXISTS (synchronize creates them in dev; this is for prod).

CREATE TABLE IF NOT EXISTS mls_commit_log (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "groupId"      UUID NOT NULL,
    "baseEpoch"    INTEGER NOT NULL,
    commit         TEXT NOT NULL,
    "senderDeviceId" VARCHAR(255),
    "createdAt"    TIMESTAMP NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "IDX_mls_commit_log_group_epoch"
    ON mls_commit_log ("groupId", "baseEpoch");

-- Age-based purge index (long retention, ~1 year; see pruneCommitLog in messaging.service).
CREATE INDEX IF NOT EXISTS "IDX_mls_commit_log_created_at"
    ON mls_commit_log ("createdAt");
