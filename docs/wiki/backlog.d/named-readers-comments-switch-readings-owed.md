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
- **Old `mention` bell rows**: a mention row cannot tell a comment's mention from a post's, so a
  comment mention delivered to a named reader BEFORE this change stays in their bell (new ones are no
  longer sent). Count them once on production (`post_notifications` of type `mention` whose recipient
  holds a `read_grants` row) - expected near zero; if not, decide whether to mark the comment ones.
