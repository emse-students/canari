-- canari:hold-for-owner - a data migration (WP-PIN): it moves the global pin into per-space pins.
--
-- Migration 128: the one global pin becomes per-space pins (WP-PIN, owner decisions of 2026-11-03;
-- docs/wiki/spaces-and-audiences-reform.md section 11, "Migration of the one global pin").
--
-- Every post flagged `posts.pinned` (exactly one on production, measured 2026-11-03) is pinned in
-- EVERY space that a BDE governs, where the post is visible, and that has room (fewer than 3 pins
-- there - all empty today). A flagged post visible in NO governed space is pinned nowhere, and a
-- NOTICE names its id. Deterministic, loses no pin that has a possible home, invents no space.
--
-- "Visible in a space" is the SQL of `postReachesSpaceSql` + `postPinnableInSpaceSql`
-- (`spaces/reader-spaces.ts`, `posts/space-pins.ts`), written out here because a migration is frozen
-- text and may not import the code that will change after it:
-- - published (not scheduled for later), not hidden by moderation, not a dead reel;
-- - an association's post: one of its audience rules reaches the space;
-- - a personal post: its author belongs to the space (campus, and a cursus entry of that formation);
-- - either: an association that republished it has a rule reaching the space.
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
-- transaction writes before this release); `posts`, `spaces`, `users`, `association_audiences` and
-- `post_republications` are only read.
SET lock_timeout = '5s';

BEGIN;

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
                  JOIN association_audiences rr ON rr."associationId" = rep."associationId"
                 WHERE rep."postId" = f.id
                   AND (rr.formation IS NULL OR rr.formation = s.formation)
                   AND (rr.campus IS NULL OR rr.campus = s.campus)))
       AND (SELECT count(*) FROM post_space_pins room WHERE room.space_id = s.id) < 3
)
INSERT INTO post_space_pins (post_id, space_id, pinned_by)
SELECT post_id, space_id, 'migration:128' FROM homes
ON CONFLICT DO NOTHING;

DO $$
DECLARE
    homeless RECORD;
BEGIN
    FOR homeless IN
        SELECT p.id FROM posts p
         WHERE p.pinned = true
           AND NOT EXISTS (SELECT 1 FROM post_space_pins h WHERE h.post_id = p.id)
    LOOP
        RAISE NOTICE 'migration 128: pinned post % is visible in no governed space with room - pinned nowhere', homeless.id;
    END LOOP;
END
$$;

COMMIT;
