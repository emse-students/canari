-- Nobody was ever told about a post, and the column that fixes it must start FULL, not empty.
--
-- No notification existed for a publication: not for an association's announcement, not for a post
-- by someone you follow. `PostNotification` only ever carried reactions to a post that already had
-- a reader. The sweeper added alongside this migration (`post-announce.scheduler.ts`) closes that,
-- and it decides what it has already announced from this column - durable state, never a clock.
--
-- STAMPING EVERY EXISTING ROW IS THE WHOLE POINT OF THE `UPDATE`, and it is the one step a revert
-- cannot undo. A null here means "not yet announced", so shipping the column empty would make the
-- sweeper's first tick treat the entire archive as new and push it: 120 posts on the local copy of
-- production, 9 of them association posts going to 356 people each. The timestamp written is the
-- post's own `createdAt` rather than `now()`, so the column reads as what it means - when the post
-- was considered announced - instead of recording the deploy.
ALTER TABLE posts ADD COLUMN IF NOT EXISTS "feedNotifiedAt" timestamptz NULL;

UPDATE posts SET "feedNotifiedAt" = "createdAt" WHERE "feedNotifiedAt" IS NULL;

-- The sweeper's `WHERE` is `"feedNotifiedAt" IS NULL`, which on a growing table is a full scan
-- every minute for a set that is almost always empty. A PARTIAL index holds only the unannounced
-- rows, so it stays a handful of entries no matter how large `posts` gets.
CREATE INDEX IF NOT EXISTS idx_posts_awaiting_announcement
  ON posts ("createdAt")
  WHERE "feedNotifiedAt" IS NULL;
