-- Migration 090: a salon message's CLIENT id, so a send repeated after a lost answer is answered with
-- the row it already made (WP-OFF-3 of docs/wiki/frontend/offline-and-weak-network.md).
--
-- The client mints a UUID for every message it composes and seals the SAME id inside the ciphertext
-- (`AppMessage.message_id`), which is what every reader already settles an echo by. It also travels in
-- clear beside the ciphertext (`messageId` on the POST), and the server used to ignore it: a POST
-- whose answer was lost could not be repeated safely, because a repeat sealed anew minted a second
-- row. Now the server keeps it, and a repeat from the SAME author in the SAME salon with the SAME id
-- returns the stored row instead of writing another.
--
-- NULLABLE: a system notice and every row written before this migration carry none, and they are
-- left alone (an edit and a reaction carry their own row id since WP-OFF-4, so they are repeatable
-- too). The index is PARTIAL for the same reason, and scoped to the author and the salon: the id is
-- chosen by the client, so it can only ever name a row of its own author - another member reusing it
-- collides with nothing.
--
-- A DELETED MESSAGE LEAVES ITS CLIENT ID BEHIND (`channel_message_client_tombstones`). A message
-- delete drops the row, and the idempotence above only holds while the row exists: a repeat arriving
-- after a delete (its first answer lost, the app killed, a moderator removing it meanwhile) would
-- find nothing and post it again - a moderation removal undone with no one touching anything. The
-- tombstone and the delete commit together, and a repeat that meets it is refused
-- (`CHANNEL_MESSAGE_DELETED`, 410); both sides take the same advisory lock on the client id
-- (`clientIdLockSql` in channel.service.ts), so a delete cannot fall between a repeat's check and its
-- insert. It holds the author, the salon and a random id - nothing a reader of the salon did not
-- already hold - and goes with its salon, or with its author's account erasure.
--
-- ONLY A MESSAGE DELETE (`deleteChannelMessage`) WRITES ONE. The two other paths that drop rows do
-- not: the retention GC (`channel-retention.scheduler.ts`) removes messages past the retention
-- window, far older than any send a client still repeats, and an account erasure deletes the author's
-- messages AND its tombstones (`account-erasure.ts`) - an erased account sends nothing again.
--
-- It reveals nothing new: the id is random, and every reader of the salon already holds it inside
-- the ciphertext.
--
-- Idempotent via IF NOT EXISTS. Not CONCURRENTLY: the CD step runs each file in a transaction.

BEGIN;

ALTER TABLE channel_messages ADD COLUMN IF NOT EXISTS "clientMessageId" VARCHAR(36);

CREATE UNIQUE INDEX IF NOT EXISTS "UQ_channel_messages_author_client_id"
  ON channel_messages ("authorId", "channelId", "clientMessageId")
  WHERE "clientMessageId" IS NOT NULL;

CREATE TABLE IF NOT EXISTS channel_message_client_tombstones (
  "authorId" VARCHAR(255) NOT NULL,
  "channelId" UUID NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  "clientMessageId" VARCHAR(36) NOT NULL,
  "deletedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY ("authorId", "channelId", "clientMessageId")
);

COMMIT;
