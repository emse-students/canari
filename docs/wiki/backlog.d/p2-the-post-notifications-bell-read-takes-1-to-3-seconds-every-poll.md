## P2 - `GET /api/posts/notifications` takes 1.1-3.6 s on every call (13.8 s and 12.8 s on one account), and the bell polls it every 60 s (1.6.8 logs, 2026-11-09)

Client: `PostNotificationBell.svelte` (~L34) polls through `lib/posts/api.ts` (~L872). Server:
`PostNotificationsService.getNotifications` then `bellPageQuery`
(`apps/social-service/src/posts/post-notifications.service.ts`, ~L804-845).

**Second data point, 2026-11-09 (owner's Firefox console, production 1.6.8, another account): 13,817 ms and 12,783 ms**, while other reads answered in 80-600 ms at the same moment - the worst request the client makes.

What makes it slow, read from the code (the shape is certain, the plan is not measured): it is PER-ROW FAN-OUT, not a missing index. Migration 126's `(recipientId, createdAt DESC)` index gives the order, but every candidate row is then filtered by `bellRowShownSql`, whose post-bound branch runs `postVisibleToViewerSql` (the whole feed visibility rule: spaces, follows, blocks, associations, anonymity) PLUS `commentsWithheldFromViewerSql` (a second visibility evaluation) as correlated subqueries, and `sameSideOfReviewCohortSql` on each. With `LIMIT` after the filter, a reader whose recent rows are mostly hidden by the predicate makes the walk evaluate that rule on history until the page fills - unbounded in the reader's backlog, which is why one account is 13 s and a light one is 1 s. A rewrite that is safe to ship needs `EXPLAIN (ANALYZE, BUFFERS)` for the slow reader first (an owner-approved production read); it was NOT attempted here because a predicate rewrite of the visibility rule cannot be proven equivalent without that plan, and an index or a materialised per-row visibility flag is a migration (not small). Candidate order: (1) measure; (2) cap the scan - read a bounded window of rows, filter, and page by cursor, so the cost is bounded by the window not the backlog; (3) evaluate the cheap predicates (`type`, `read`, birthday) before the visibility rule; (4) only then a stored flag.

Earlier note, read from the code and NOT measured (it needs an `EXPLAIN (ANALYZE)` on production
data, an owner-approved read): the page is "the reader's rows, newest first, with the predicate and
LIMIT in one SELECT", sized so the correlated `bellRowShownSql` and `sameSideOfReviewCohortSql` run on
about one page. That holds only when most rows pass; a reader whose recent rows are mostly hidden by
the predicate makes the index walk traverse history until the page fills. A second query follows when
the page holds a `repost_proposed` row. Order of work: measure the plan for a slow reader; if the walk
is the cost, materialise visibility at write time; independently, refresh on an unread-count change
pushed by the existing channels instead of a 60 s clock.
