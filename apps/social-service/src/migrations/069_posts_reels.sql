-- CanaReels (user, 2026-09-29, decisions C2/C4/C6): a post may be a REEL - one short video that the
-- app deletes, with its comments, reactions and blob, a month after it was published.
--
-- A reel is a row of `posts`, not a table of its own: it shares the feed, the reactions, the
-- comments, the reports and the moderation, and a second table would have meant a second copy of
-- each. What makes it a reel is three columns that stand or fall together.
--
--   kind        'post' (every row that exists today) or 'reel'.
--   durationMs  the length the CLIENT declared, 1..90000. The server cannot read inside the
--               ciphertext, so this is a declaration enforced at the door (`reel.constants.ts`
--               owns the 90 000, and the DB does not repeat it: two copies of a number is how they
--               drift) - see docs/wiki/services/reels.md for what that does and does not prove.
--   expiresAt   when the worker deletes it. Set ONCE, at publication, to createdAt + 30 days, so the
--               worker's question ("is it due?") is answered by a column and by nothing else - no
--               "last run" marker, no clock arithmetic at deletion time.
--
-- NOTHING EXISTING BECOMES A REEL. The default is 'post' and there is no UPDATE: every current row
-- keeps kind 'post' with both other columns NULL, which the CHECK below states and the worker's
-- `kind = 'reel'` predicate relies on. IF NOT EXISTS / DROP IF EXISTS keep it re-runnable, since a
-- deploy that fails midway re-applies the files after it.
ALTER TABLE posts ADD COLUMN IF NOT EXISTS kind varchar(16) NOT NULL DEFAULT 'post';
ALTER TABLE posts ADD COLUMN IF NOT EXISTS "durationMs" integer NULL;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS "expiresAt" timestamptz NULL;

-- The three columns are ONE fact, so the database refuses a row that states it in pieces: a reel
-- with no expiry would never be deleted, a post with one would be deleted by nobody and read as
-- expired by every reader.
ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_kind_shape;
ALTER TABLE posts ADD CONSTRAINT posts_kind_shape CHECK (
  (kind = 'post' AND "durationMs" IS NULL AND "expiresAt" IS NULL)
  OR (kind = 'reel' AND "durationMs" IS NOT NULL AND "durationMs" > 0 AND "expiresAt" IS NOT NULL)
);

-- The worker asks `WHERE kind = 'reel' AND "expiresAt" <= now()`; the feed asks nothing of this
-- index. A PARTIAL index holds only reels, so it stays as small as the reels alive however large
-- `posts` gets (the same shape as 058's idx_posts_awaiting_announcement).
CREATE INDEX IF NOT EXISTS idx_posts_reels_expiry ON posts ("expiresAt") WHERE kind = 'reel';
