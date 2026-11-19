## P2 - a post that is not published yet takes no comment (owner, 2026-11-19)

target: 1.7.2

**Decided by the owner on 2026-11-19** ([decisions](owner-decisions-of-2026-11-19.md)), answering the
question of 2026-11-15 on a reported comment under a scheduled post: *"On ne devrait pas pouvoir
commenter un post programmé."* The question disappears with its cause.

**Owed:** the comment route refuses a post whose `publishedAt` is in the future (a typed refusal, not a
message to parse), for every author including the post's own; the client hides the comment box on such a
post (Paraglide for any new string); the integration spec; a read-only count on production of comments
already under a not-yet-published post (expected 0, the platform admin reads any that exist). The
moderation read rule of 2026-11-15 then needs no case for them
([moderation](../moderation-and-blocking.md#the-moderation-read-of-a-post-its-comments-and-its-replay-owner-2026-11-15)).
