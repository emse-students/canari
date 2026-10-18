-- Migration 093: the transactional outbox of a salon message's fan-out (backlog: "A salon row
-- committed by a process that died before its broadcast is never broadcast or pushed").
--
-- `sendMessage` commits the row and THEN publishes `channel.message.created` and rings the phones,
-- fire-and-forget. A process killed between the two left a stored row no peer was told about live
-- and no phone was rung for. The fix is an outbox: one row here, inserted in the SAME transaction as
-- the message, deleted once the publish and the push fan-out are handed off, and drained at boot (a
-- crash is the only thing that leaves one behind). A repeat of a send (WP-OFF-3) drains its own row
-- at once.
--
-- THIS FILE SHIPS A RELEASE BEFORE THE CODE THAT WRITES IT. The deploy starts the services BEFORE it
-- runs the migrations, so a send that inserted here in the same release would fail whole, storing
-- nothing, for the seconds between the two (the lesson of migration 090).
--
-- `payload` holds what the push needs and the row does not: the sender's cleartext
-- `mentionedUserIds` and the seed frame (an MLS private message, opaque to the server) that rides
-- the push. It lives only until the hand-off.
--
-- CASCADE on the message: a deleted message, or an erased account's messages, leave no outbox row
-- behind. Idempotent via IF NOT EXISTS. Not CONCURRENTLY: the CD step runs each file in a transaction.

BEGIN;

CREATE TABLE IF NOT EXISTS channel_message_fanout (
  "messageId" UUID PRIMARY KEY REFERENCES channel_messages (id) ON DELETE CASCADE,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMIT;
