### Fixed - an event's card no longer shows a post scheduled for later

The agenda's link back to a post (`GET /posts/calendar-link/:eventId`) served a scheduled post to
every reader of its association before its hour; it now keeps published posts only, as the feed,
the search and the post by id do. Found by the audience audit of 2026-11-14
([audit](docs/wiki/backlog.d/audience-audit-2026-11-14.md)).
