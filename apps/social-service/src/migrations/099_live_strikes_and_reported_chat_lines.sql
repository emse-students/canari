-- Migration 099: the strike ladder and the reported chat line (WP-L8b; the owner's decisions of
-- 2026-10-20 in docs/wiki/services/lives.md "Decisions of 2026-10-20" and "The strike ladder").
--
-- 1. live_cuts.strike: the cut's place on its broadcaster's ladder, FIXED WHEN IT IS RECORDED -
--    1 + the broadcaster's other cuts on record (the rolling 90 days, LIVE_STRIKE_WINDOW_MS). Strike
--    1 is the warning; from strike 2 the cut SUSPENDS the right to broadcast for 30 days from its
--    "cutAt". Kept on the row, not recomputed, so the prune of an OLDER cut (90 days) can never lift
--    a suspension that cut helped cause. Every row recorded before this file is strike 1: no
--    sanction read them when they were made, and none is applied to them after the fact.
-- 2. live_broadcast_withdrawals: the right to broadcast WITHDRAWN BY STAFF (the 3rd abuse, a
--    person's decision, never automatic). One row per account, deleted when staff lift it or the
--    account is erased; the moderator who decided is anonymised by THEIR erasure.
-- 3. live_chat_reported_lines: a REPORTED live chat line, kept until its report is handled and never
--    longer than 90 days (LIVE_CHAT_REPORT_MAX_KEEP_MS), erased by the live sweep. It holds the
--    PLAINTEXT the reporter handed over, which the server checked against the sealed line with the
--    live key it still held at report time - and the key is NOT kept. NO foreign key to `lives`: the
--    line must survive the live's cascade. A foreign key to `content_reports` that CASCADES: a
--    report deleted takes its line. `sealedSha256` names the ciphertext the text was checked
--    against without keeping it. `signature` (the content, "keptAt" included), `authorSignature`
--    and `reporterSignature` (the report id with ONE account id each) are HMAC-SHA256 under
--    LIVE_REPORT_SIGNING_KEY, `keyId` naming it. The AUTHOR's erasure anonymises "authorId" and
--    leaves the line (owner, 2026-10-20).
-- 4. content_reports_reporter_content_uniq: ONE report per reporter per thing, which
--    ModerationService checked by a read and two concurrent requests could both pass. PARTIAL,
--    WHERE "reporterId" <> '[deleted]': an erasure anonymises "reporterId", and two erased
--    reporters of one thing must not collide. Checked on 2026-10-21 against both estates before it
--    was written: NO duplicate (reporterId, contentId) in either, so the index is created on the
--    rows as they are and nothing is deleted.
--
-- User ids are varchar(255): a 64-char hex digest, never a uuid. Additive only: one column with a
-- default, two new tables, one index. Idempotent for CD (IF NOT EXISTS, constraints added once by name).
-- 099: main ends at 098 (2026-10-21) and no open pull request holds it.

ALTER TABLE live_cuts ADD COLUMN IF NOT EXISTS strike smallint NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS live_broadcast_withdrawals (
  "userId" varchar(255) PRIMARY KEY,
  -- The staff member who withdrew: anonymised, never deleted, by an erasure of that account.
  "reviewerId" varchar(255) NOT NULL,
  reason varchar(32) NOT NULL,
  details text NULL,
  "withdrawnAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT live_broadcast_withdrawals_reason
    CHECK (reason IN ('spam', 'harassment', 'inappropriate', 'other'))
);

CREATE TABLE IF NOT EXISTS live_chat_reported_lines (
  "reportId" uuid PRIMARY KEY,
  "liveId" uuid NOT NULL,
  "messageId" uuid NOT NULL,
  seq integer NOT NULL,
  "authorId" varchar(255) NOT NULL,
  "clientId" uuid NOT NULL,
  "sealedSha256" varchar(64) NOT NULL,
  text text NOT NULL,
  "messageCreatedAt" timestamptz NOT NULL,
  "keptAt" timestamptz NOT NULL DEFAULT now(),
  "keyId" varchar(16) NOT NULL,
  signature varchar(64) NOT NULL,
  "authorSignature" varchar(64) NOT NULL,
  "reporterSignature" varchar(64) NOT NULL
);
CREATE INDEX IF NOT EXISTS live_chat_reported_lines_kept_at_idx
  ON live_chat_reported_lines ("keptAt");
CREATE INDEX IF NOT EXISTS live_chat_reported_lines_author_idx
  ON live_chat_reported_lines ("authorId");

CREATE UNIQUE INDEX IF NOT EXISTS content_reports_reporter_content_uniq
  ON content_reports ("reporterId", "contentId") WHERE "reporterId" <> '[deleted]';

DO $$
DECLARE
  ns oid := to_regnamespace(current_schema())::oid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'live_cuts_strike' AND connamespace = ns) THEN
    ALTER TABLE live_cuts ADD CONSTRAINT live_cuts_strike CHECK (strike >= 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'live_chat_reported_lines_report_fk' AND connamespace = ns) THEN
    ALTER TABLE live_chat_reported_lines ADD CONSTRAINT live_chat_reported_lines_report_fk
      FOREIGN KEY ("reportId") REFERENCES content_reports (id) ON DELETE CASCADE;
  END IF;
END
$$;
