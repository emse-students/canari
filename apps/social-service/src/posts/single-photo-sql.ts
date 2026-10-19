/**
 * A POST WHOSE ONLY CONTENT IS ONE PICTURE, as a clause over the `posts` row - what the CanaReels
 * list adds to the reels (user, 2026-10-19: photos in CanaReels, as on Instagram;
 * `GET /api/posts?kind=reel&singlePhotos=true`).
 *
 * Exactly one attachment (`images` is the stored column of `media`), and that attachment a
 * picture: its `type`, or - for a row stored before `type` existed - its `mimeType`, the same
 * reading as the client's `resolveMediaType`. A poll or a form keeps the post out: a full-screen
 * page could not be answered. The client reads one row the same way (`reels/fullScreenPost.ts`);
 * the two are pinned against the same cases by `posts.service.reels.spec.ts` and
 * `fullScreenPost.test.ts`.
 *
 * WHO MAY SEE THE POST IS NOT DECIDED HERE: this narrows a feed arm that already carries every
 * visibility, moderation, block, promo and schedule clause a post has.
 */
export const SINGLE_PHOTO_POST_SQL = `jsonb_array_length(COALESCE(posts.images, '[]'::jsonb)) = 1
           AND (
             posts.images->0->>'type' = 'image'
             OR (posts.images->0->>'type' IS NULL AND posts.images->0->>'mimeType' LIKE 'image/%')
           )
           AND jsonb_array_length(COALESCE(posts.polls, '[]'::jsonb)) = 0
           AND jsonb_array_length(COALESCE(posts.forms, '[]'::jsonb)) = 0
           AND posts."attachedFormId" IS NULL`;
