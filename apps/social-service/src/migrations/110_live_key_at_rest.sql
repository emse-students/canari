-- Migration 110: a live's key is SEALED at rest (docs/wiki/services/lives.md#the-live-key-at-rest).
--
-- Until now `lives."liveKey"` held the 32-byte key in the clear (migration 091), next to the chat
-- ciphertext it opens (`live_chat_messages.sealed`, 098) and the segment names it opens - so a
-- database copy or a backup alone could open a live's chat and segments. From now on the row keeps:
--
--   "liveKeyCiphertext"  AES-256-GCM under a key derived from LIVE_KEY_ENCRYPTION_SECRET
--                        (`src/common/secret-box.ts`), a fresh IV per seal, AAD = the live id and
--                        the version: a ciphertext copied to another row does not open.
--   "liveKeyVersion"     which secret sealed it, so the secret can be rotated
--                        (`src/lives/live-key-at-rest.ts`).
--
-- THE EXISTING ROWS ARE NOT SEALED HERE: the secret is not, and must never be, in the database. The
-- live sweep (`LivesService.sealPlaintextKeys`, every 30 s) seals every row still holding a
-- plaintext key, one conditional UPDATE per row that writes the ciphertext and NULLs the plaintext
-- in the same statement - idempotent, safe if interrupted (a row is either wholly before or wholly
-- after), and re-run at every tick. Until it reaches a row, `openLiveKey` reads the plaintext, at
-- WARN. A live is open an hour at most and its row is purged after its end, so the set is small.
--
-- "liveKey" becomes NULLABLE and stays, for one release: the previous release's replica keeps
-- writing it during the rolling deploy. Its DROP is owed once production counts 0 non-null rows
-- (docs/wiki/legacy-compatibility.md).
--
-- The CHECKs: a row holds exactly ONE form of its key, and a ciphertext always names its version.
-- Every existing row (plaintext, no ciphertext) satisfies both.
--
-- THE OVERLAP DEPLOY AND A ROLLBACK: social-service is `canari.deploy.replace: overlap`, so while both
-- releases answer - and after a rollback, until the live ends (an hour at most) - the OLD release
-- reads only "liveKey". For every live the new sweep has already sealed it serves `key: null` and
-- answers a chat-line report 400 LIVE_CHAT_REPORT_MISMATCH. The new sweep seals lives ALREADY OPEN
-- too, so this reaches a live on air before the deploy. Dev only today (LIVE_ENABLED is false in
-- production). Nothing to undo in the schema: the columns are additive, the previous code never
-- names them, and a plaintext is never restored (that would undo the point).
--
-- LOCK: the ALTERs take ACCESS EXCLUSIVE on `lives`, which every segment and manifest reads, so the
-- migration gives up after 5 s rather than queue every live request behind a long transaction; the
-- deploy then fails loudly and a re-run is safe (idempotent below).
--
-- Idempotent for CD: IF NOT EXISTS, and catalogue checks scoped to the current schema.
-- 110: 106-109 are taken by open pull requests (#2265, #2273, #2258, #2284).

SET lock_timeout = '5s';

ALTER TABLE lives ADD COLUMN IF NOT EXISTS "liveKeyCiphertext" text NULL;
ALTER TABLE lives ADD COLUMN IF NOT EXISTS "liveKeyVersion" smallint NULL;
ALTER TABLE lives ALTER COLUMN "liveKey" DROP NOT NULL;

-- The sweep's backfill reads only the rows still in the previous form.
CREATE INDEX IF NOT EXISTS lives_plaintext_key_idx ON lives (id) WHERE "liveKey" IS NOT NULL;

DO $$
DECLARE
  ns oid := (SELECT oid FROM pg_namespace WHERE nspname = current_schema());
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lives_key_one_form' AND connamespace = ns) THEN
    ALTER TABLE lives ADD CONSTRAINT lives_key_one_form
      CHECK (("liveKey" IS NULL) <> ("liveKeyCiphertext" IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lives_key_version' AND connamespace = ns) THEN
    ALTER TABLE lives ADD CONSTRAINT lives_key_version
      CHECK (("liveKeyCiphertext" IS NULL) = ("liveKeyVersion" IS NULL));
  END IF;
END
$$;
