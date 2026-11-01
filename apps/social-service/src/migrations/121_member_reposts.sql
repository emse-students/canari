-- Migration 121: member reposts with the author's consent (WP-F6, decided by the user on
-- 2026-10-25, consent shape decided by the owner on 2026-11-01; docs/wiki/profiles-and-access.md
-- "WP-F6 - member reposts").
--
-- A PERSON republishes a post to THEIR OWN ACCEPTED followers. Three things, all ADDITIVE:
--
-- - `member_reposts`, one row per (post, reposter). The reader predicate
--   (`spaces/reader-spaces.ts` `memberRepostReachesUserSql`) reads it: the post becomes visible to
--   the reposter's ACCEPTED followers (never a pending request), never for an anonymous post, never
--   across a block. The pair is the key, so a second repost of the same post by the same person is a
--   409. A deleted post takes its reposts with it (the foreign key); hiding a post, a withdrawn
--   consent and a block delete them in the service; the reposter's erasure deletes theirs.
--   `reposterId` carries no foreign key: `users` is core-service's table.
-- - `user_repost_settings`, the AUTHOR's account-wide consent "Autoriser mes abonnes a republier
--   mes posts" (owner, 2026-11-01). NO ROW MEANS THE DEFAULT, which is ON: nothing is backfilled,
--   and a person who never opened the setting consents exactly as the owner decided. A row exists
--   only once the person chose.
-- - `posts."allowReposts"`, the PER-POST override: NULL follows the account setting, true or false
--   overrides it for that one post. Nullable with no default, so on PostgreSQL 11+ the column is a
--   catalogue change, not a table rewrite.
--
-- An ENTITY post (association, list, institution) is reposted without consent (Q2): neither the
-- setting nor the override is read for it.
--
-- ROLLBACK: an image older than this migration never reads these, so a repost written meanwhile
-- reaches nobody under it - it fails closed. Forward-only by intent.
--
-- Idempotent for CD: IF NOT EXISTS throughout; the deploy ledger replays a file whose predecessor
-- failed mid-run.
--
-- LOCK TIMEOUT: `posts` is read by every feed; if a long transaction holds it, this migration gives
-- up after five seconds rather than queue every query behind its ACCESS EXCLUSIVE request. The
-- deploy then fails loudly, and a re-run is safe.
SET lock_timeout = '5s';

BEGIN;

ALTER TABLE posts ADD COLUMN IF NOT EXISTS "allowReposts" boolean NULL;

CREATE TABLE IF NOT EXISTS member_reposts (
    "postId"      uuid NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
    "reposterId"  varchar(255) NOT NULL,
    "repostedAt"  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT "PK_member_reposts" PRIMARY KEY ("postId", "reposterId")
);
-- The reader predicate joins on the post (the primary key); the Suivis arm, the erasure and the
-- block severing read by reposter.
CREATE INDEX IF NOT EXISTS "IDX_member_reposts_reposter" ON member_reposts ("reposterId");

CREATE TABLE IF NOT EXISTS user_repost_settings (
    "userId"        varchar(255) PRIMARY KEY,
    "allowReposts"  boolean NOT NULL DEFAULT true,
    "updatedAt"     timestamptz NOT NULL DEFAULT now()
);

COMMIT;
