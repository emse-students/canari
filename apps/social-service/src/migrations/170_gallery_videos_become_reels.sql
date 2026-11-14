-- canari:hold-for-owner - DESTRUCTIVE: every single-video post becomes a CanaReel expiring one year after its publication, so a video published more than a year ago is DELETED at the reel worker's next tick.
-- Migration 170 : the videos already posted become CanaReels (owner, 2026-11-14).
--
-- THE DECISION, verbatim: "Toute vidéo verticale et/ou inférieure à 90 s est un CanaReel, y compris
-- depuis la galerie", and asked whether the videos already posted follow: "Oui, toutes" - each one a
-- CanaReel expiring ONE YEAR AFTER ITS PUBLICATION, the owner knowing that a video older than a year
-- then goes at once (docs/wiki/services/reels.md#the-rule-what-is-a-canareel).
--
-- WHAT IT CONVERTS, AND ONLY THAT (an allowlist in the WHERE - docs/wiki/open-questions.md):
--   - `kind = 'post'`: never a reel already, never a live replay;
--   - EXACTLY ONE media, and it is a video (`type = 'video'` or a `video/*` mimeType): a post with
--     several media, or a photo beside its video, STAYS A POST (owner, 2026-11-14:
--     "Rester des posts" - converting it would delete its photos with the video, and a reel carries
--     one video);
--   - no poll, no form, no attached form, no linked event: a reel carries none of them (the create
--     door refuses each), and the member chose them;
--   - `"publishedAt" <= now()`: a post scheduled for later is not published yet and stays a post.
-- "Toutes" means EVERY video whatever its frame and length: the stored media carry no length, so the
-- vertical-or-short rule cannot be read on them, and the owner did not ask for it to be.
--
-- WHAT IT WRITES: `kind = 'reel'`, `"expiresAt" = "publishedAt" + 365 days` (the owner's year, the
-- default of `retention_reel_days` - written as a literal, so this file reads no core column), and
-- `"durationMs"` LEFT NULL: nobody ever declared these videos' length, and a reader takes the video's
-- own when none is declared (`PostMedia`, `segmentedMediaStream`), where an invented one would be
-- shown as the length and set as the stream's. So `posts_kind_shape` (migration 156) is re-created
-- first, widened by exactly that: a `reel` may have a NULL `durationMs`. The create door still
-- refuses a reel without one (`assertCreateKindShape`), so the NULL marks THIS migration's rows and
-- no other - which is what makes the rollback below exact.
--
-- WHAT FOLLOWS, WITHOUT THIS FILE: the hourly `ReelRetentionScheduler` deletes every converted row
-- whose year has passed - the post, its comments, reactions and notifications, and its video
-- (`purgeReelBlobs`, the uploader's own file only); social-service's next boot claims the rest's
-- blobs as `reel` (`PostMediaRetentionService.backfillReels`). The converted posts leave the feed
-- (`kind = 'post'`) and join the CanaReels list, newest first.
--
-- HOW MANY, BEFORE IT RUNS - the read-only count by age band, the same allowlist. Read on 2026-11-14:
-- dev 2 (all under 30 days), production 39 under 30 days and 1 from 30 to 180 days, NONE over a year
-- (the oldest post is of 2026-05-13), so the conversion itself deletes nothing; 0 and 4 multi-media
-- posts with a video stay posts:
--
--   SELECT CASE
--            WHEN p."publishedAt" > now() - interval '30 days'  THEN '1. under 30 days'
--            WHEN p."publishedAt" > now() - interval '180 days' THEN '2. 30 to 180 days'
--            WHEN p."publishedAt" > now() - interval '365 days' THEN '3. 180 to 365 days'
--            ELSE '4. over a year: DELETED at the next tick'
--          END AS band,
--          count(*) AS posts
--     FROM posts p
--    WHERE p.kind = 'post' AND jsonb_typeof(p.images) = 'array' AND jsonb_array_length(p.images) = 1
--      AND (p.images->0->>'type' = 'video' OR lower(p.images->0->>'mimeType') LIKE 'video/%')
--      AND COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(p.polls) = 'array' THEN p.polls END), 0) = 0
--      AND COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(p.forms) = 'array' THEN p.forms END), 0) = 0
--      AND p."attachedFormId" IS NULL AND p."linkedCalendarEventId" IS NULL
--      AND p."publishedAt" <= now()
--    GROUP BY 1 ORDER BY 1;
--
-- and what it leaves as posts (several media with a video), for the open question:
--
--   SELECT count(*) FROM posts p
--    WHERE p.kind = 'post' AND jsonb_typeof(p.images) = 'array' AND jsonb_array_length(p.images) > 1
--      AND EXISTS (SELECT 1 FROM jsonb_array_elements(p.images) m
--                   WHERE m->>'type' = 'video' OR lower(m->>'mimeType') LIKE 'video/%');
--
-- Idempotent for CD: DROP CONSTRAINT IF EXISTS before the re-create; a second run finds no `post`
-- that matches (every match is a `reel` now) and writes nothing. LOCKS: ACCESS EXCLUSIVE on `posts`
-- for the constraint swap (NOT VALID: a catalogue change, no scan), then SHARE UPDATE EXCLUSIVE for
-- the VALIDATE scan (blocks neither reads nor writes), then row locks on the converted posts; gives
-- up after 5 s rather than queue behind a long transaction (the re-run is safe).
--
-- ROLLBACK, for the rows the worker has not yet deleted (a deleted one is gone - THAT is the
-- destruction this file is held for; restoring it means the backup of the day before):
--
--   UPDATE posts SET kind = 'post', "expiresAt" = NULL
--    WHERE kind = 'reel' AND "durationMs" IS NULL;
--
-- then the constraint of migration 156 put back. Their blobs keep the `reel` class until
-- social-service's next boot, whose `archive` pass re-classifies every blob a post cites. An image
-- older than this migration reads the converted rows as reels with no length, which it already
-- tolerates (`post.durationMs` is optional on every client), and never writes one.

SET lock_timeout = '5s';

BEGIN;

ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_kind_shape;
ALTER TABLE posts ADD CONSTRAINT posts_kind_shape CHECK (
  (kind = 'post' AND "durationMs" IS NULL AND "expiresAt" IS NULL AND "liveId" IS NULL)
  OR (kind = 'reel' AND ("durationMs" IS NULL OR "durationMs" > 0) AND "expiresAt" IS NOT NULL
      AND "liveId" IS NULL)
  OR (kind = 'replay' AND "durationMs" IS NOT NULL AND "durationMs" > 0 AND "expiresAt" IS NOT NULL
      AND "liveId" IS NOT NULL)
) NOT VALID;
ALTER TABLE posts VALIDATE CONSTRAINT posts_kind_shape;

UPDATE posts p
   SET kind = 'reel',
       "expiresAt" = p."publishedAt" + interval '365 days'
 WHERE p.kind = 'post'
   AND jsonb_typeof(p.images) = 'array'
   AND jsonb_array_length(p.images) = 1
   AND (p.images->0->>'type' = 'video' OR lower(p.images->0->>'mimeType') LIKE 'video/%')
   AND COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(p.polls) = 'array' THEN p.polls END), 0) = 0
   AND COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(p.forms) = 'array' THEN p.forms END), 0) = 0
   AND p."attachedFormId" IS NULL
   AND p."linkedCalendarEventId" IS NULL
   AND p."publishedAt" <= now();

COMMIT;
