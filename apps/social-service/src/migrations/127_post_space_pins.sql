-- Migration 127: post_space_pins - a pin is a promotion PER SPACE, not a global flag (WP-PIN,
-- owner decisions of 2026-11-03; docs/wiki/spaces-and-audiences-reform.md section 11).
--
-- One row per (post, space): the post is pinned for the readers of that space, by the governor of
-- that space (a BDE member holding MODERATE there) or the platform admin. A pin never expires; only
-- an unpin deletes it. A pin whose post stops being visible in its space is KEPT and simply not
-- shown (`space-pins.ts` computes "visible" at read time, so no hook on any visibility change is
-- needed and nothing can drift). At most 3 are SHOWN per space - one shared rank, `pinned_at` DESC
-- then `post_id` - and the cap is held by the pin transaction under an advisory lock on the space.
--
-- `posts.pinned`, the global flag, stops being read by the code that ships with this table. The one
-- row it holds on production is moved by migration 128 (held for the owner); the column is dropped
-- later, after the window recorded in docs/wiki/legacy-compatibility.md.
--
-- Both foreign keys cascade: a deleted post or a closed space takes its pins with it. `pinned_by`
-- carries no foreign key - `users` is core-service's table - and the account erasure anonymises it
-- (`account-erasure.ts`).
--
-- ADDITIVE ONLY: a new table and its index. ROLLBACK: an image older than this migration never reads
-- the table and keeps reading `posts.pinned`, which this migration does not touch.
--
-- Idempotent for CD: IF NOT EXISTS everywhere.
--
-- LOCKS: the two foreign keys take a SHARE ROW EXCLUSIVE lock on `posts` and on `spaces` until
-- COMMIT - writes to either wait for the length of a CREATE TABLE on an empty table (no scan, no
-- backfill), reads are not blocked.
-- LOCK TIMEOUT: if a long transaction holds `posts`, this migration gives up after five seconds
-- rather than queue every write behind its request. The deploy then fails loudly, and a re-run is
-- safe.
SET lock_timeout = '5s';

BEGIN;

CREATE TABLE IF NOT EXISTS post_space_pins (
    post_id    uuid         NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
    space_id   uuid         NOT NULL REFERENCES spaces (id) ON DELETE CASCADE,
    pinned_by  varchar(255) NOT NULL,
    pinned_at  timestamptz  NOT NULL DEFAULT now(),
    PRIMARY KEY (post_id, space_id)
);

-- The rank partitions by space and orders by pinned_at; the governor's list reads one space.
CREATE INDEX IF NOT EXISTS "IDX_post_space_pins_space"
    ON post_space_pins (space_id, pinned_at DESC, post_id);

COMMIT;
