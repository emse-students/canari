-- Migration 065: Graine v2's two server-side facts - a message's signature, and one row per key.
--
-- See docs/wiki/protocols/channel-encryption.md section 21.
--
-- 1. `signature`: the Ed25519 signature a v2 session's key makes over the message's header, nonce and
--    ciphertext, base64 (64 bytes, so 88 characters). The server cannot verify it - it holds no key
--    and does not know which sessions are v2, since the version travels with the seed over MLS - so
--    it only stores and relays it. A v1 row has none, and the v1 reader's removal condition is a
--    COUNT of the rows without one (legacy-compatibility).
--
-- 2. ONE ROW PER (senderSessionId, messageIndex). A message key is HKDF(seed, session, index), so a
--    second row under the same pair is either a REPLAY of a stored ciphertext or a sender that sealed
--    two messages under one key. Neither is a message anybody should be shown, and the reader hides
--    the second; refusing it at the door is what makes that true for every reader at once.
--    MEASURED BEFORE WRITTEN, 2026-09-29: production 123 rows, dev 67, zero duplicate pairs on both.
--    Partial on "senderSessionId" IS NOT NULL like the index it sits beside (043).
--
-- Idempotent via IF NOT EXISTS. Not CONCURRENTLY: the CD step runs each file in a transaction, and
-- at 123 rows the lock costs nothing.

BEGIN;

ALTER TABLE channel_messages ADD COLUMN IF NOT EXISTS "signature" VARCHAR(88);

CREATE UNIQUE INDEX IF NOT EXISTS "UQ_channel_messages_session_index"
  ON channel_messages ("senderSessionId", "messageIndex")
  WHERE "senderSessionId" IS NOT NULL;

COMMIT;
