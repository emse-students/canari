-- Migration 098: live chat and floating reactions (WP-L6 of docs/wiki/frontend/modules/live.md,
-- decisions C1-C16 in docs/wiki/services/lives.md "Live chat and floating reactions").
--
-- EPHEMERAL BY CONSTRUCTION (C2): both tables hang off `lives` with ON DELETE CASCADE, and a live's
-- row is deleted at its end (at once, or by the 30 s sweep). No replay of the chat, no grace period.
--
-- THE ORDER IS THE LIVE'S ROW LOCK (C4): "chatSeq" and "reactionSeq" on `lives` are incremented in
-- the same transaction that inserts the row, under `SELECT ... FOR UPDATE` on the live, so sequence
-- numbers commit in their own order and a poller's cursor ("the highest seq I was given") never skips
-- a row still uncommitted. A `bigserial` would not give that.
--
-- A message is CIPHERTEXT under the live key ("sealed", C12); a hidden one has it erased (NULL) and a
-- new "seq", which is how the hide reaches every viewer's next poll (C14). A reaction burst is a
-- client's taps summed over at most a second (C7), with the 2 s "window" of the live it fell in.
--
-- A DELETED ACCOUNT (`LIVES_ERASURE_STATEMENTS`): its messages and its bursts are deleted.
-- User ids are varchar(255): a 64-char hex digest, never a uuid.
--
-- Additive: two columns with defaults on `lives`, two new tables. Idempotent for CD.
-- 098: 094 is the highest on main and 096 is taken by an open pull request (2026-10-19); 095 and 097
-- are left to the work in flight on the same day (live moderation, WP-L8).

ALTER TABLE lives ADD COLUMN IF NOT EXISTS "chatSeq" integer NOT NULL DEFAULT 0;
ALTER TABLE lives ADD COLUMN IF NOT EXISTS "reactionSeq" integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS live_chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "liveId" uuid NOT NULL,
  seq integer NOT NULL,
  "authorId" varchar(255) NOT NULL,
  "clientId" uuid NOT NULL,
  sealed bytea NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "hiddenAt" timestamptz NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS live_chat_messages_seq ON live_chat_messages ("liveId", seq);
CREATE UNIQUE INDEX IF NOT EXISTS live_chat_messages_client
  ON live_chat_messages ("liveId", "authorId", "clientId");
CREATE INDEX IF NOT EXISTS live_chat_messages_author_idx
  ON live_chat_messages ("authorId", "createdAt");

CREATE TABLE IF NOT EXISTS live_reaction_bursts (
  "liveId" uuid NOT NULL,
  seq integer NOT NULL,
  "userId" varchar(255) NOT NULL,
  "burstId" uuid NOT NULL,
  "window" integer NOT NULL,
  counts jsonb NOT NULL,
  taps integer NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT live_reaction_bursts_pkey PRIMARY KEY ("liveId", seq)
);
CREATE UNIQUE INDEX IF NOT EXISTS live_reaction_bursts_burst
  ON live_reaction_bursts ("liveId", "userId", "burstId");
CREATE INDEX IF NOT EXISTS live_reaction_bursts_user_idx
  ON live_reaction_bursts ("userId", "createdAt");

DO $$
DECLARE
  ns oid := to_regnamespace(current_schema())::oid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lives_chat_seq' AND connamespace = ns) THEN
    ALTER TABLE lives ADD CONSTRAINT lives_chat_seq CHECK ("chatSeq" >= 0 AND "reactionSeq" >= 0);
  END IF;
  -- Hidden is exactly "no ciphertext": a hide erases it in the same statement that dates it.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'live_chat_messages_hidden' AND connamespace = ns) THEN
    ALTER TABLE live_chat_messages ADD CONSTRAINT live_chat_messages_hidden
      CHECK (("hiddenAt" IS NULL) = (sealed IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'live_chat_messages_live_fk' AND connamespace = ns) THEN
    ALTER TABLE live_chat_messages ADD CONSTRAINT live_chat_messages_live_fk
      FOREIGN KEY ("liveId") REFERENCES lives (id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'live_reaction_bursts_taps' AND connamespace = ns) THEN
    ALTER TABLE live_reaction_bursts ADD CONSTRAINT live_reaction_bursts_taps CHECK (taps > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'live_reaction_bursts_live_fk' AND connamespace = ns) THEN
    ALTER TABLE live_reaction_bursts ADD CONSTRAINT live_reaction_bursts_live_fk
      FOREIGN KEY ("liveId") REFERENCES lives (id) ON DELETE CASCADE;
  END IF;
END
$$;
