-- Migration 134 : a deleted post's id is never created again (2026-11-06).
--
-- docs/wiki/services/social-service.md, "A post created twice is the same post". The app's publish
-- queue mints a post's id on the device and sends it again until an answer arrives, so a resend of a
-- post the member deleted meanwhile - or one the server already took down - would bring it back.
-- `createPost` refuses an id written here (410).
--
-- 1. `deleted_post_ids`: the id and when it went. Nothing else: no author, no content, so the table
--    says nothing about anybody - an id alone names no person, and the post it named is gone.
-- 2. A trigger AFTER DELETE ON posts writes the row, so EVERY hard delete path writes it - the
--    service's delete, the account erasure, the reel retention, a cascade, and any path added later -
--    with nothing for a writer to remember. `ON CONFLICT DO NOTHING` keeps the first date.
--
-- ADDITIVE: a new table, a new function, a new trigger. Idempotent for CD: IF NOT EXISTS, CREATE OR
-- REPLACE, DROP TRIGGER IF EXISTS before the CREATE TRIGGER. No row of `posts` is read or changed.
-- LOCKS: CREATE TRIGGER takes SHARE ROW EXCLUSIVE on `posts` for the catalogue change alone (reads go
-- on, writes wait for it), released at COMMIT; the migration gives up after 5 s rather than queue.

SET lock_timeout = '5s';

BEGIN;

CREATE TABLE IF NOT EXISTS deleted_post_ids (
  id          uuid        PRIMARY KEY,
  "deletedAt" timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION remember_deleted_post_id() RETURNS trigger AS $$
BEGIN
  INSERT INTO deleted_post_ids (id) VALUES (OLD.id) ON CONFLICT (id) DO NOTHING;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS posts_remember_deleted_id ON posts;
CREATE TRIGGER posts_remember_deleted_id
  AFTER DELETE ON posts
  FOR EACH ROW EXECUTE FUNCTION remember_deleted_post_id();

COMMIT;
