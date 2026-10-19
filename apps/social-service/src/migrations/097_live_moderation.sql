-- Migration 097: the moderation of a live (WP-L8 of docs/wiki/frontend/modules/live.md, decisions
-- D3 and D6) and the first-live rules (L11). See docs/wiki/services/lives.md, "Moderation".
--
-- 1. lives."endReason" accepts 'cut': staff ended the live (`POST /api/lives/:id/cut`).
-- 2. live_cuts: ONE ROW PER CUT LIVE, the moderation record. It OUTLIVES the live row (deleted at
--    its end, L3) on purpose: it is what a viewer or the broadcaster polling after the purge is
--    answered `410 LIVE_ENDED` with `endReason: 'cut'` from, the audit trail of the decision (who,
--    when, which reason code), and the count of a broadcaster's earlier cuts a moderator reads. No
--    strike POLICY reads it yet - that is the user's decision (backlog). "broadcasterId" and
--    "associationId" repeat the live's, so the rule of a post (`liveVisibleToViewerSql`) can be asked
--    of this row once the live's is gone. Kept LIVE_CUT_RETENTION_MS (a planning year), deleted by
--    the live sweep past it.
-- 3. live_rules_acceptances: the member accepted the rules shown before a first live, at that
--    version (`LIVE_RULES_VERSION`). One row per account, raised when the rules change.
--
-- A DELETED ACCOUNT (`LIVES_ERASURE_STATEMENTS` in src/internal/account-erasure.ts): its cuts and
-- its acceptance are deleted; a cut it made as a moderator keeps the decision and loses the name.
--
-- User ids are varchar(255): a user id is a 64-char hex digest, never a uuid. No foreign key from
-- live_cuts to lives: the live row is deleted at its end, the cut is not.
--
-- Idempotent for CD: IF NOT EXISTS, and the one CHECK replaced by DROP ... IF EXISTS then ADD (the
-- same definition each run). 097: main ends at 094, #2116 holds 096 and #1940 is renumbering into
-- the space under it (2026-10-19).

ALTER TABLE lives DROP CONSTRAINT IF EXISTS lives_end_reason;
ALTER TABLE lives ADD CONSTRAINT lives_end_reason
  CHECK ("endReason" IS NULL OR "endReason" IN ('broadcaster', 'dropped', 'max_duration', 'erased', 'cut'));

CREATE TABLE IF NOT EXISTS live_cuts (
  "liveId" uuid PRIMARY KEY,
  "broadcasterId" varchar(255) NOT NULL,
  "associationId" uuid NULL,
  -- The staff member who cut: anonymised, never deleted, by an erasure of that account.
  "reviewerId" varchar(255) NOT NULL,
  reason varchar(32) NOT NULL,
  details text NULL,
  "liveStartedAt" timestamptz NOT NULL,
  "cutAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT live_cuts_reason CHECK (reason IN ('spam', 'harassment', 'inappropriate', 'other'))
);
CREATE INDEX IF NOT EXISTS live_cuts_broadcaster_idx ON live_cuts ("broadcasterId", "cutAt");
CREATE INDEX IF NOT EXISTS live_cuts_cut_at_idx ON live_cuts ("cutAt");

CREATE TABLE IF NOT EXISTS live_rules_acceptances (
  "userId" varchar(255) PRIMARY KEY,
  "rulesVersion" integer NOT NULL,
  "acceptedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT live_rules_acceptances_version CHECK ("rulesVersion" >= 1)
);
