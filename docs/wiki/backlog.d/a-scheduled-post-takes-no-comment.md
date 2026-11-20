## P2 - a post that is not published yet takes no comment (owner, 2026-11-19)

target: 1.7.2

**Decided by the owner on 2026-11-19** ([decisions](owner-decisions-of-2026-11-19.md)), answering the
question of 2026-11-15 on a reported comment under a scheduled post: *"On ne devrait pas pouvoir
commenter un post programmé."* The question disappears with its cause.

**Shipped:** the route refusal, the client gate and the integration spec
([moderation](../moderation-and-blocking.md#a-post-that-is-not-published-yet-takes-no-comment-owner-2026-11-19)).

**Owed:** a read-only count on production of comments already under a not-yet-published post (expected
0, the platform admin reads any that exist). Delete this file once it is read.
