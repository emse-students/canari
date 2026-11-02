-- Migration 123: member_repost_notices - the durable "have I already told them" of a member repost
-- (WP-F6 hardening; docs/wiki/profiles-and-access.md "WP-F6 - member reposts").
--
-- A repost tells the readers it reaches for the FIRST time (`NEWLY_REACHED_BY_MEMBER_REPOST_SQL`),
-- and that set is read from visibility, which a take-back undoes: without a record, every repost of
-- the same post - by the same person after an "Annuler", or by another follower's followed person -
-- would announce it again to the same reader. One row per (post, recipient), written in the repost's
-- own transaction the first time that reader is told about that post through a repost; a reader
-- whose pair exists is never told again, whoever reposts it. It is not a repost, and nothing reads it
-- but that decision.
--
-- The post's foreign key cascades, so a deleted post takes its ledger with it; the recipient's
-- account erasure deletes their rows (`account-erasure.ts`). `recipientId` carries no foreign key:
-- `users` is core-service's table.
--
-- BACKFILLED from the bell: every `member_repost` row already written stands for a reader already
-- told, so they are recorded and not told again. Additive (an INSERT of what exists); a replay finds
-- every pair present and writes nothing.
--
-- ROLLBACK: an image older than this migration never reads the table; a row written meanwhile is
-- inert. Forward-only by intent.
--
-- Idempotent for CD: IF NOT EXISTS, and ON CONFLICT DO NOTHING for the backfill.
--
-- LOCK TIMEOUT: the foreign key takes a SHARE ROW EXCLUSIVE lock on `posts`, read by every feed; if
-- a long transaction holds it, this migration gives up after five seconds rather than queue every
-- query behind it. The deploy then fails loudly, and a re-run is safe.
SET lock_timeout = '5s';

BEGIN;

CREATE TABLE IF NOT EXISTS member_repost_notices (
    "postId"       uuid NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
    "recipientId"  varchar(255) NOT NULL,
    "createdAt"    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT "PK_member_repost_notices" PRIMARY KEY ("postId", "recipientId")
);
-- The erasure deletes by recipient; the primary key serves the repost.
CREATE INDEX IF NOT EXISTS "IDX_member_repost_notices_recipient"
    ON member_repost_notices ("recipientId");

INSERT INTO member_repost_notices ("postId", "recipientId")
SELECT DISTINCT n."postId"::uuid, n."recipientId"
  FROM post_notifications n
  JOIN posts p ON p.id::text = n."postId"
 WHERE n.type = 'member_repost'
ON CONFLICT DO NOTHING;

COMMIT;
