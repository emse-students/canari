-- Migration 159 : friends' activity (engagement WP-9, decisions 5b and 9).
--
-- docs/wiki/engagement.md, "(b) friends' activity - the disclosure rule" and "No double
-- notification". When X reacts to or comments on post P, the accepted followers of X who already
-- see P are told once - under the nine rules of the disclosure list, read at the write in ONE
-- statement (`posts/friend-activity.ts`).
--
-- `user_activity_settings` - decision 9, "share my activity": ONE ROW PER PERSON WHO CHOSE, no row
-- is ON (the `user_repost_settings` pattern), so the default needs no backfill. Turning it off stops
-- every notice not yet sent and retracts none already sent. Erasure: the person's row.
--
-- `post_engagement_notices` - the told-once ledger every new engagement path writes BEFORE it
-- pushes, pushing only the rows it inserted: ONE ROW PER (post, recipient), the primary key, so two
-- concurrent paths are ordered by the key and never by a clock; `reason` says which path told them
-- (friends' activity now, a campus trend in WP-10). Deleted with its post (ON DELETE CASCADE, as
-- `member_repost_notices`); the recipient index serves the erasure.
--
-- ADDITIVE: two new tables and an index, no existing row read or changed; the foreign key takes a
-- brief lock on `posts` at creation, which `lock_timeout` bounds. Idempotent for CD: IF NOT EXISTS.

SET lock_timeout = '5s';

BEGIN;

CREATE TABLE IF NOT EXISTS user_activity_settings (
  "userId"        varchar(255) PRIMARY KEY,
  "shareActivity" boolean      NOT NULL DEFAULT true,
  "updatedAt"     timestamptz  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS post_engagement_notices (
  "postId"      uuid         NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
  "recipientId" varchar(255) NOT NULL,
  reason        varchar(16)  NOT NULL CHECK (reason IN ('friend', 'trend', 'suggested')),
  "createdAt"   timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY ("postId", "recipientId")
);
CREATE INDEX IF NOT EXISTS "IDX_post_engagement_notices_recipient"
  ON post_engagement_notices ("recipientId");

COMMIT;
