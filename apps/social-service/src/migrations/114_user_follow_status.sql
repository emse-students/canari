-- Migration 114: user_follows."status", a follow of a PERSON becomes a request the person answers
-- (WP-F1, decided by the user on 2026-10-25: every personal account is private, Q1).
--
-- See apps/social-service/src/follows/entities/user-follow.entity.ts and
-- docs/wiki/backlog.md ("Follow requests, member reposts, and visibility between spaces").
--
-- `user_follows` is person-to-person only: an association, a list or an institution is followed
-- through `association_follows`, which stays free and gets no status.
--
-- THE TWO DEFAULTS ARE DELIBERATE AND DIFFERENT:
-- - The column is ADDED with DEFAULT 'accepted', so every row that exists today is recorded as
--   accepted (decision 3: existing follows are kept). On PostgreSQL 11+ a constant default is a
--   catalogue change, not a table rewrite.
-- - The default is then SET to 'pending', so a writer that forgets the column fails CLOSED: a row
--   nobody accepted never counts as a follow. The image that runs this code always writes the
--   status explicitly; the OLD image, which keeps serving for the seconds between this migration
--   and its replacement, writes no status and its rows land 'pending' - a request, which is exactly
--   what a follow of a person now is.
--
-- Readers count 'accepted' rows only (FollowsService, the announce sweep, the live push); the
-- account erasure and the block severing delete rows whatever their status.
--
-- ROLLBACK: an image older than this migration reads every row as a follow, so a 'pending' row
-- written meanwhile would act as an accepted one until rolled forward. Forward-only by intent.
--
-- Idempotent for CD: IF NOT EXISTS, and the constraint is dropped before it is re-added.
--
-- LOCK TIMEOUT: `user_follows` is read by every Suivis feed; if a long transaction holds it, this
-- migration gives up after five seconds rather than queue every query behind its ACCESS EXCLUSIVE
-- request. The deploy then fails loudly, and a re-run is safe.
SET lock_timeout = '5s';

BEGIN;

ALTER TABLE user_follows ADD COLUMN IF NOT EXISTS status varchar(16) NOT NULL DEFAULT 'accepted';
ALTER TABLE user_follows ALTER COLUMN status SET DEFAULT 'pending';

ALTER TABLE user_follows DROP CONSTRAINT IF EXISTS "CHK_user_follows_status";
ALTER TABLE user_follows ADD CONSTRAINT "CHK_user_follows_status"
    CHECK (status IN ('pending', 'accepted'));

-- The request inbox (WP-F2) reads what is pending FOR a person.
CREATE INDEX IF NOT EXISTS "IDX_user_follows_pending_followed"
    ON user_follows ("followedUserId") WHERE status = 'pending';

COMMIT;
