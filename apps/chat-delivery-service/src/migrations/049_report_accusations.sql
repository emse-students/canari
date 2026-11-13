-- Migration 049: report_accusations, what the hourly health reports have already accused (2026-11-13).
--
-- chat-delivery's hourly reports (reportCommitLogHealth, reportSingleHolderGroups,
-- reportStrandedDeviceMemberships, reportStaleExternalJoinBases) re-printed the SAME permanent state
-- every hour - eleven holes dated 2026-08-29..31, two conversations closed for good since 2026-10-14 -
-- at ERROR, 24 identical lines a day each, so the next real hole would have hidden behind them. A row
-- here records that one item was accused in one exact state; the report accuses an item only when no
-- row holds that state, and deletes the rows of the items it no longer names. The row answers "was this
-- state already accused", never "is it broken": the report's own query answers that, every hour.
-- Mechanism: docs/wiki/services/chat-delivery.md ("Each item is accused once").
--
-- Additive: a new table, no existing row touched. Empty on arrival, so the first run after the deploy
-- accuses every current item once - the last time the known ones are printed at ERROR or WARN.
-- Reversible: a release that predates it never reads it, so a rollback is safe; `DROP TABLE
-- report_accusations` undoes it entirely (the reports then accuse every item once more).
-- Idempotent: CREATE TABLE IF NOT EXISTS (synchronize creates it in dev; this is for prod).
--
-- LOCK TIMEOUT: creating a table locks no existing one, but the migration still gives up after five
-- seconds rather than queue behind a long transaction on the catalogue; the deploy then fails loudly
-- and a re-run is safe. Asserted by `migrations.lock-timeout.spec.ts`.
SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS "report_accusations" (
    "report"    VARCHAR(64)  NOT NULL,
    "itemId"    VARCHAR(512) NOT NULL,
    "state"     TEXT         NOT NULL,
    "accusedAt" TIMESTAMPTZ  NOT NULL DEFAULT now(),
    PRIMARY KEY ("report", "itemId")
);
