-- WP-31/32: a channel message names the Graine session it was sealed under, and its index in it.
--
-- Two columns and not one. `senderSessionId` says WHOSE seed opens the message; `messageIndex`
-- says which key of that session, and the key is HKDF(seed, sessionId, index) - so a row without
-- the index is a row nobody can read, including its own author. They replace `keyVersion`, which
-- named an epoch the SERVER derived and could therefore read; the drop of that column, of
-- `channels.masterSecret` and of the derivation itself is WP-50/51.
--
-- Nullable, because the rows written before this migration have neither and never will: the cut
-- (WP-60) deletes every community, channel and message rather than pretending an epoch-key
-- ciphertext can be re-sealed. A NOT NULL here would only make the migration fail on a database
-- that is about to be emptied.
ALTER TABLE channel_messages ADD COLUMN IF NOT EXISTS "senderSessionId" VARCHAR(64);
ALTER TABLE channel_messages ADD COLUMN IF NOT EXISTS "messageIndex" INTEGER;
