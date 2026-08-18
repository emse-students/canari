-- WP-50/51: the server forgets how to read a channel.
--
-- Every column here existed so the SERVER could derive a channel's AES key: `channels.masterSecret`
-- was the HKDF root, `channels.keyVersion` the epoch it was at, `channel_messages.keyVersion` the
-- epoch a row was sealed under, `channel_members.keys` the per-channel copies handed to a member,
-- and `channel_key_distributions` the four-state ledger tracking a key's trip to an invitee. With
-- Graine the key is HKDF(seed, sessionId, index) and the seed never leaves the sending devices, so
-- none of it has a reader left - and a root secret nothing uses is a root secret nobody rotates.
--
-- Dropped, not left nullable: while `masterSecret` exists, a future read path can derive from it,
-- and the point of this work is that the ability is GONE. The cut (WP-60) empties every one of
-- these tables at the same deploy, so no row is losing data it could still have been read with.
ALTER TABLE channel_messages DROP COLUMN IF EXISTS "keyVersion";
ALTER TABLE channels DROP COLUMN IF EXISTS "masterSecret";
ALTER TABLE channels DROP COLUMN IF EXISTS "keyVersion";
ALTER TABLE channel_members DROP COLUMN IF EXISTS "keys";
DROP TABLE IF EXISTS channel_key_distributions;
