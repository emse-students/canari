-- canari:hold-for-owner - a data migration (WP-PIN): it moves the global pin into per-space pins.
--
-- Migration 128: the one global pin becomes per-space pins (WP-PIN, owner decisions of 2026-11-03;
-- docs/wiki/spaces-and-audiences-reform.md section 11, "Migration of the one global pin").
--
-- Every post flagged `posts.pinned` (exactly one on production, measured 2026-11-03) is pinned in
-- EVERY space that a BDE governs, where the post is visible, and that has room (fewer than 3 pins
-- there - all empty today; with several flagged posts competing for one space's room, the lower
-- post id goes first). Deterministic, loses no pin that has a possible home, invents no space.
--
-- EVERY PIN NOT CARRIED IS NAMED BY A NOTICE, so the run's log is the hand-work list:
-- - each governed space where a flagged post is visible but which had no room left (post, space);
-- - each flagged post that ends with no pin row at all - visible in no governed space, or NOT LIVE
--   at run time (hidden by moderation, scheduled for later, an expired reel). Such a post is not
--   re-examined later: nothing re-runs this migration, so it is re-pinned by hand if wanted
--   (docs/wiki/legacy-compatibility.md, the `posts.pinned` row).
--
-- "Visible in a space" is the SQL of `postReachesSpaceSql` + `postPinnableInSpaceSql`
-- (`spaces/reader-spaces.ts`, `posts/space-pins.ts`), written out here because a migration is frozen
-- text and may not import the code that will change after it:
-- - published (not scheduled for later), not hidden by moderation, not a dead reel;
-- - an association's post: one of its audience rules reaches the space;
-- - a personal post: its author belongs to the space (campus, and a cursus entry of that formation);
-- - either: an association that republished it, and is not archived, has a rule reaching the space.
-- The review cohort (`review-cohort.ts`) is configuration, not data, and is not read here: a review
-- account's post was never the pinned one.
--
-- `pinned_by` is `migration:128`: the flag never recorded who set it. `posts.pinned` is NOT cleared -
-- nothing reads it any more, and the column goes in a later migration after the window recorded in
-- docs/wiki/legacy-compatibility.md.
--
-- Held for the owner's hand-merge (`-- canari:hold-for-owner`, docs/wiki/cicd.md): a data move. It
-- writes rows only (INSERT ... ON CONFLICT DO NOTHING), so a replay finds every pair present and
-- writes nothing. Requires migration 127.
--
-- LOCKS: none beyond the row locks of the INSERT into `post_space_pins` (a table no other
-- transaction writes before this release) and the transaction's own temporary table
-- (`m128_candidates`, dropped at COMMIT); `posts`, `spaces`, `users`, `association_audiences` and
-- `post_republications` are only read.
SET lock_timeout = '5s';

BEGIN;

-- Every (flagged live post, governed space where it is visible) pair, room or not.
CREATE TEMPORARY TABLE m128_candidates ON COMMIT DROP AS
WITH flagged AS (
    SELECT p.* FROM posts p
     WHERE p.pinned = true
       AND (p."scheduledAt" IS NULL OR p."scheduledAt" <= now())
       AND NOT COALESCE(p."hiddenByModeration", false)
       AND (p.kind <> 'reel' OR p."expiresAt" > now())
), homes AS (
    SELECT f.id AS post_id, s.id AS space_id
      FROM flagged f
      JOIN spaces s ON s."bdeAssociationId" IS NOT NULL
     WHERE (
            (f."associationId" IS NULL AND EXISTS (
                SELECT 1 FROM users u
                 WHERE u.id = f."authorId" AND u.campus = s.campus
                   AND u.cursus @> jsonb_build_array(jsonb_build_object('formation', s.formation))))
         OR (f."associationId" IS NOT NULL AND EXISTS (
                SELECT 1 FROM association_audiences r
                 WHERE r."associationId" = f."associationId"
                   AND (r.formation IS NULL OR r.formation = s.formation)
                   AND (r.campus IS NULL OR r.campus = s.campus)))
         OR EXISTS (
                SELECT 1 FROM post_republications rep
                  JOIN associations rep_asso ON rep_asso.id = rep."associationId"
                  JOIN association_audiences rr ON rr."associationId" = rep."associationId"
                 WHERE rep."postId" = f.id AND NOT COALESCE(rep_asso.archived, false)
                   AND (rr.formation IS NULL OR rr.formation = s.formation)
                   AND (rr.campus IS NULL OR rr.campus = s.campus)))
)
SELECT post_id, space_id FROM homes;

-- The room: a space takes candidates (lowest post id first) only up to 3 pins in all, counting the
-- pins it already holds. A pair already present (a replay) is neither re-inserted nor counted twice.
INSERT INTO post_space_pins (post_id, space_id, pinned_by)
SELECT c.post_id, c.space_id, 'migration:128'
  FROM (SELECT c0.*, ROW_NUMBER() OVER (PARTITION BY c0.space_id ORDER BY c0.post_id) AS nth
          FROM m128_candidates c0
         WHERE NOT EXISTS (SELECT 1 FROM post_space_pins e
                            WHERE e.post_id = c0.post_id AND e.space_id = c0.space_id)) c
 WHERE (SELECT count(*) FROM post_space_pins room WHERE room.space_id = c.space_id) + c.nth <= 3
ON CONFLICT DO NOTHING;

DO $$
DECLARE
    skipped RECORD;
    homeless RECORD;
BEGIN
    FOR skipped IN
        SELECT c.post_id, c.space_id FROM m128_candidates c
         WHERE NOT EXISTS (SELECT 1 FROM post_space_pins h
                            WHERE h.post_id = c.post_id AND h.space_id = c.space_id)
         ORDER BY c.post_id, c.space_id
    LOOP
        RAISE NOTICE 'migration 128: pinned post % is visible in governed space % but that space had no room - not pinned there, re-pin by hand', skipped.post_id, skipped.space_id;
    END LOOP;
    FOR homeless IN
        SELECT p.id FROM posts p
         WHERE p.pinned = true
           AND NOT EXISTS (SELECT 1 FROM post_space_pins h WHERE h.post_id = p.id)
         ORDER BY p.id
    LOOP
        RAISE NOTICE 'migration 128: pinned post % is pinned nowhere (not live at run time, or visible in no governed space with room) - not re-run, re-pin by hand', homeless.id;
    END LOOP;
END
$$;

COMMIT;
