-- Migration 122: a salon message DECLARES the reel file it carries, so a moderator purges only what
-- a message of THEIR salon names (RC-14, docs/wiki/frontend/modules/reels-in-chat.md section 15.4).
--
-- APPROVED BY THE OWNER ON 2026-10-30 ("Oui", decision M1 in section 9.2 of that page): "the salon
-- message row records the reel's mediaId so a moderator only deletes what is in their salon".
--
-- Why it is needed: one take sent to several conversations is ONE stored file (D-oneblob), so a
-- salon moderator's purge erases it everywhere. The purge must therefore prove that the moderator's
-- salon cites the file - and the server cannot read a Graine body. The sender declares the id beside
-- the ciphertext; the purge (`chat-reel-purge`) is allowed only when the row declares that id, the
-- caller moderates the row's salon, the file's recorded uploader is the row's author, and a
-- conversation holds the file. A lying author can only offer up a file of their OWN.
--
-- What it reveals: nothing the server did not hold. It stored the upload and serves every fetch of
-- it; the id is the same one every reader of the salon holds inside the ciphertext.
--
-- ADDITIVE AND NULLABLE: every existing row, every non-reel message and every client older than the
-- writer carries none - and such a row can never be purged through this path, the safe direction.
-- Nullable with no default, so on PostgreSQL 11+ the column is a catalogue change, not a rewrite.
-- No index: it is read only by primary key, on the row a moderator deletes.
--
-- AN ORDINARY COLUMN OF THE ENTITY: the send writes it in its own INSERT, inside its transaction,
-- and the moderator's delete reads it with the row it already loads. That is safe because the deploy
-- applies migrations BEFORE it replaces the services (`deploy-environment.sh`, then `rolling.sh`):
-- no build that names this column ever runs against a schema without it.
--
-- ROLLBACK: an image older than this migration never reads the column; a value written meanwhile is
-- inert. Forward-only by intent.
--
-- Idempotent via IF NOT EXISTS.
--
-- LOCK TIMEOUT: `channel_messages` is read and written by every salon; if a long transaction holds
-- it, this migration gives up after five seconds rather than queue every send behind its ACCESS
-- EXCLUSIVE request. The deploy then fails loudly, and a re-run is safe.
SET lock_timeout = '5s';

BEGIN;

ALTER TABLE channel_messages ADD COLUMN IF NOT EXISTS "reelMediaId" UUID NULL;

COMMIT;
