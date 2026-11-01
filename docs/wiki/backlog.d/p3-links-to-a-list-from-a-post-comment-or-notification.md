## P3 - links to a list built from a post, a comment or a notification still say `/associations/` (2026-10-31)

`postAuthorHref`, `commentAuthorHref` and `resolveNotificationHref` build `/associations/<slug>` (and its `/edit/<section>`) because the post and comment payloads carry no entity type. It works: the association page forwards a list to `/lists/<slug>` and the association edit page forwards a list to `/lists/<slug>/edit/<section>`, at the cost of one redirect. The fix is the entity type in the post author payload; do it with the next change to that payload, not alone.
