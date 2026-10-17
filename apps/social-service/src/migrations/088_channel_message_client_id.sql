-- Migration 088: a salon message's CLIENT id, so a send repeated after a lost answer is answered with
-- the row it already made (WP-OFF-3 of docs/wiki/frontend/offline-and-weak-network.md).
--
-- The client mints a UUID for every message it composes and seals the SAME id inside the ciphertext
-- (`AppMessage.message_id`), which is what every reader already settles an echo by. It also travels in
-- clear beside the ciphertext (`messageId` on the POST), and the server used to ignore it: a POST
-- whose answer was lost could not be repeated safely, because a repeat sealed anew minted a second
-- row. Now the server keeps it, and a repeat from the SAME author in the SAME salon with the SAME id
-- returns the stored row instead of writing another.
--
-- NULLABLE: a silent row (a reaction, an edit) and every row written before this migration carry
-- none, and they are left alone. The index is PARTIAL for the same reason, and scoped to the author
-- and the salon: the id is chosen by the client, so it can only ever name a row of its own author -
-- another member reusing it collides with nothing.
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

COMMIT;
