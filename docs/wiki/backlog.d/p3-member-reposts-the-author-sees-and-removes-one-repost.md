## P3 - member reposts: the author cannot see who reposted, nor remove one repost (decided 2026-11-01)

WP-F6 shipped member reposts with the author's consent ([as built](../profiles-and-access.md#wp-f6---member-reposts-with-the-authors-consent-as-built-2026-11-01)).
Accepted for `1.6.0` (the lead, holding the owner's autonomy, 2026-11-01): an author who wants a
repost gone withdraws consent on the WHOLE post (its override "Interdire"), which removes every
repost of it at once. Two follow-ups are owed:

- **A list of the reposters, for the author only**, on the author's own post - read from
  `member_reposts` (post, reposter, date), paged by cursor like the follow lists, minus the accounts
  on the other side of a block with the author.
- **Removing ONE repost**: `DELETE /api/posts/:id/reposts/:reposterId` for the author of a personal
  post, under the author's consent lock (`member-repost:author:<id>`) then the post row, the order
  `MemberRepostsService` takes; whether it also stops that person reposting the post again is a
  product question to settle first (a durable per-pair refusal, as a D38b refusal stands, or a
  plain delete).

Proof owed: an integration case that the list shows only the author's own post's reposters and
nobody else can read it, and that one removal leaves the other reposts and the reach they give.
