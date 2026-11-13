-- Migration 156: live replays - a finished live kept three days as a CanaReel (owner, 2026-11-07
-- and 2026-11-09; docs/wiki/live-replays.md, WP-R1).
--
-- 1. `lives."keepsReplay"`: whether THIS live keeps a replay, fixed at its start from core's
--    `platform_config.live_replays_mode` (migration 021 of core-service), so a flip mid-live never
--    makes half a replay. `false` for every existing row and by default: nothing changes until an
--    admin moves the switch, and a live started before that is deleted at its end as today.
--    `lives."replayPostedAt"`: when the live's replay post was created, in the same transaction - the
--    durable answer to "was this live's replay already published", so a replay that expired or was
--    deleted is never published a second time by the next sweep (the post's absence alone could not
--    tell "not yet" from "already gone").
-- 2. `posts."liveId"`: the live a `kind = 'replay'` post shows. NO CASCADE, on purpose: the live's
--    purge waits for the post to be gone (the post's deletion is what releases the segments), so a
--    live deleted under its replay is an error the database refuses, never a silent loss. A UNIQUE
--    partial index makes the replay's creation idempotent (`ON CONFLICT DO NOTHING`): two replicas,
--    a crash, a retry - one replay per live.
-- 3. `posts_kind_shape` re-created with the `replay` shape: `durationMs`, `expiresAt` and `liveId`
--    all present; every other kind keeps `liveId` NULL. Added NOT VALID then validated (the scan
--    takes SHARE UPDATE EXCLUSIVE, which blocks neither reads nor writes; every existing row is a
--    `post` or a `reel` with `liveId` NULL, so it cannot fail).
-- 4. The expiry index re-created on every row that expires (`"expiresAt" IS NOT NULL`), so the
--    hourly worker's `"expiresAt" <= NOW()` reads it for reels and replays alike.
-- 5. `live_replay_cap_evictions`: one row per replay deleted early because the replays together
--    passed the total cap (decision D5, `LIVE_REPLAY_TOTAL_MAX_GB`), the durable record the admin
--    storage panel reads to show it. Pruned after 30 days by the live sweep.
--
-- ADDITIVE: new columns (a constant default is a catalogue change, no rewrite), a new table, new
-- indexes, a constraint and an index re-created under the same meaning widened. No row is written.
-- Idempotent for CD: IF NOT EXISTS, DROP ... IF EXISTS before each re-create.
-- LOCKS: ACCESS EXCLUSIVE on `posts` and `lives` for the catalogue changes and the two small index
-- builds, released at COMMIT. A request holding one makes the migration give up after 5 s rather than
-- queue (the re-run is safe).

SET lock_timeout = '5s';

BEGIN;

ALTER TABLE lives ADD COLUMN IF NOT EXISTS "keepsReplay" boolean NOT NULL DEFAULT false;
ALTER TABLE lives ADD COLUMN IF NOT EXISTS "replayPostedAt" timestamptz NULL;

ALTER TABLE posts ADD COLUMN IF NOT EXISTS "liveId" uuid NULL;

ALTER TABLE posts DROP CONSTRAINT IF EXISTS "FK_posts_live";
ALTER TABLE posts ADD CONSTRAINT "FK_posts_live"
  FOREIGN KEY ("liveId") REFERENCES lives (id) NOT VALID;

CREATE UNIQUE INDEX IF NOT EXISTS "UQ_posts_live" ON posts ("liveId") WHERE "liveId" IS NOT NULL;

ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_kind_shape;
ALTER TABLE posts ADD CONSTRAINT posts_kind_shape CHECK (
  (kind = 'post' AND "durationMs" IS NULL AND "expiresAt" IS NULL AND "liveId" IS NULL)
  OR (kind = 'reel' AND "durationMs" IS NOT NULL AND "durationMs" > 0 AND "expiresAt" IS NOT NULL
      AND "liveId" IS NULL)
  OR (kind = 'replay' AND "durationMs" IS NOT NULL AND "durationMs" > 0 AND "expiresAt" IS NOT NULL
      AND "liveId" IS NOT NULL)
) NOT VALID;

DROP INDEX IF EXISTS idx_posts_reels_expiry;
CREATE INDEX IF NOT EXISTS idx_posts_expiry ON posts ("expiresAt") WHERE "expiresAt" IS NOT NULL;

CREATE TABLE IF NOT EXISTS live_replay_cap_evictions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "liveId" uuid NOT NULL,
  -- The replay's bytes when it was evicted, and the replays' total that made the sweep evict it.
  bytes bigint NOT NULL,
  "totalBytes" bigint NOT NULL,
  "capBytes" bigint NOT NULL,
  "evictedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS live_replay_cap_evictions_at
  ON live_replay_cap_evictions ("evictedAt");

COMMIT;

ALTER TABLE posts VALIDATE CONSTRAINT "FK_posts_live";
ALTER TABLE posts VALIDATE CONSTRAINT posts_kind_shape;
