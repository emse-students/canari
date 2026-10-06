-- One deterministic answer to "when did this post become visible": `publishedAt`.
--
-- Until now the feed ordered and the card displayed `createdAt`, the moment the author PRESSED the
-- button. A post scheduled at noon for 18:00 therefore appeared at 18:00 but sat behind everything
-- posted between 12:00 and 18:00, labelled with the noon time. `publishedAt` is `scheduledAt` for a
-- scheduled post and the creation time for an immediate one, set by the service on every write that
-- touches `scheduledAt` (`PostsService.publicationTime`), so there is no job to flip and nothing
-- that can run late: the visibility predicate (`scheduledAt <= NOW()`) and the order key now read
-- the same instant.
--
-- Backfill: COALESCE("scheduledAt", "createdAt") covers both halves of the rule at once - a
-- published scheduled post gets its scheduledAt, every other post its createdAt (so an immediate
-- post's order is unchanged). A still-pending post gets its scheduledAt, which is also what the
-- service will set. Re-runnable: ADD COLUMN IF NOT EXISTS, and the UPDATE only touches NULLs.
ALTER TABLE posts ADD COLUMN IF NOT EXISTS "publishedAt" timestamptz NULL;

UPDATE posts SET "publishedAt" = COALESCE("scheduledAt", "createdAt") WHERE "publishedAt" IS NULL;

ALTER TABLE posts ALTER COLUMN "publishedAt" SET DEFAULT now();
ALTER TABLE posts ALTER COLUMN "publishedAt" SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_posts_published_at ON posts ("publishedAt" DESC);
