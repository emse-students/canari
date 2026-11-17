-- Migration 053: uninvited_entries, one row per entry members reported as nobody's (2026-11-17).
--
-- `POST mls/uninvited-entry` prints `[UNINVITED_ENTRY]`, the count the admission rule's fix-forward
-- is read on (docs/wiki/backlog.d/p1-the-admission-rule-fix-forward.md, item 1). Its deduplication
-- lived in one replica's memory and the line in one container's log, so a deploy reset both and the
-- count never accumulated: each reading covered the hours since the last deploy. A row here is that
-- deduplication made durable - one per (group, entrant, epoch, kind), claimed by
-- `INSERT ... ON CONFLICT DO NOTHING`, so N members reporting one entry make one row per kind they
-- reached, across deploys and replicas - and the count is one `GROUP BY kind`.
-- Mechanism: docs/wiki/protocols/mls-protocol.md ("The count is a table").
--
-- The same content as the log line it de-duplicates, and the same lifetime: "entrantUserDevice" is
-- the line's own shortened form (the user id cut to eight characters, `sanitizeLeafLogValue`), never
-- a full user id - pseudonymous, since the device id re-identifies the person. "epoch" and
-- "watchedFrom" hold a safe integer's digits or a fixed word, classified before the INSERT. Rows
-- older than the retention window (90 days, the database's clock) are deleted daily and at boot,
-- with the group by its purge, and with the account by its erasure.
--
-- Additive: a new table, no existing row touched, nothing deleted. Reversible: a release that
-- predates it never reads it; `DROP TABLE uninvited_entries` undoes it (the count then restarts).
-- Idempotent: CREATE ... IF NOT EXISTS (synchronize creates it in dev; this is for prod).
--
-- LOCK TIMEOUT: creating a table locks no existing one, but the migration still gives up after five
-- seconds rather than queue behind a long transaction on the catalogue; the deploy then fails loudly
-- and a re-run is safe. Asserted by `migrations.lock-timeout.spec.ts`.
SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS "uninvited_entries" (
    "groupId"     UUID         NOT NULL,
    "entrantUserDevice" VARCHAR(255) NOT NULL,
    "epoch"       VARCHAR(32)  NOT NULL,
    "kind"        VARCHAR(32)  NOT NULL,
    "watchedFrom" VARCHAR(32)  NOT NULL,
    "firstSeenAt" TIMESTAMPTZ  NOT NULL DEFAULT now(),
    PRIMARY KEY ("groupId", "entrantUserDevice", "epoch", "kind")
);

-- The daily sweep deletes by age.
CREATE INDEX IF NOT EXISTS "IDX_uninvited_entries_firstSeenAt"
    ON "uninvited_entries" ("firstSeenAt");
