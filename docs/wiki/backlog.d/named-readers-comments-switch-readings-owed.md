## P2 - the named readers' comment switch (owner, 2026-11-04): built, owed its dev reading and one policy look

Built and proven against PostgreSQL ([profiles-and-access](../profiles-and-access.md#nominative-read-grants-as-built-wp-c-2026-10-08)).
What closes it:

- **One dev reading after a pre-release**, with a throwaway grantee (no space) granted a campus
  whose association post carries a comment, a reaction and a named poll vote: switch OFF - the card
  shows no comment button or count, the reaction badge shows the total and opens no list,
  `GET /api/posts/:id/comments` and `POST /comments` answer 404, `POST /reactions` 201 with
  `otherReactionCounts`; switch ON in `/admin/read-access` - the comments and the names come back,
  and the journal shows both changes; every fixture removed afterwards.
- **The privacy policy** (`frontend/src/routes/legal/privacy/+page.svelte`) does not describe named
  readers at all - neither the 2026-10-07 grants nor this narrowing. Whether it should is the owner's
  call; the register row C5 now says what they read
  ([register](../compliance/register-of-processing.md)).
- **Old `mention` bell rows, measured once, read-only (done 2026-11-04, see below).** Since migration 132 a comment's mention
  carries its `commentId` and the bell hides it from a withheld reader; a row written before is
  classified by its actor (anybody but the post's author, or the anonymous actor on a post that is
  not anonymous, is a comment). Two old comment mentions still look like a post's and stay shown:
  the post author's own comment mention, and an anonymous or association comment's on an anonymous
  post. The population, on production, by the lead - a SELECT and nothing else:

  ```sql
  SELECT n."commentId" IS NOT NULL AS classified_at_write,
         n."actorId" IS NOT DISTINCT FROM p."authorId" AS actor_is_post_author,
         n."actorId" = '' AS anonymous_actor,
         p.anonymous AS anonymous_post,
         count(*) AS rows
    FROM post_notifications n
    JOIN posts p ON p.id::text = n."postId"
   WHERE n.type = 'mention'
     AND EXISTS (SELECT 1 FROM read_grants g WHERE g.user_id = n."recipientId")
   GROUP BY 1, 2, 3, 4
   ORDER BY 1, 2, 3, 4;
  ```

  The ambiguous groups are `classified_at_write = false` with `actor_is_post_author = true`, or
  with `anonymous_actor` and `anonymous_post` both true. **Measured 2026-11-04, read-only: the
  query returns no row - three accounts hold a read grant and none of them holds a `mention` row,
  so the ambiguity touches nobody and this point is closed.**
- **Live chat on an association live: the same rule, decided by the owner on 2026-11-04, not built.**
  A named reader who sees a live only through their grant sees the video but not its chat - no lines,
  no sending - unless their switch in the read-access grid is on; the same switch, no second one.
