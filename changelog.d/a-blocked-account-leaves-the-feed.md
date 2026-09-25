### Changed - a blocked account's posts and comments leave the feed, in both directions

Feed, search, single-post read and agenda card now hide a blocked account's personal posts and
their comments, symmetrically. An association post and an anonymous one are exempt on purpose:
filtering those on authorship would turn a block into a way to ask who wrote them
([moderation-and-blocking](docs/wiki/moderation-and-blocking.md)).

### Fixed - search served posts every feed refused

`searchPosts` carried neither the moderation-hide nor the store-review account exclusion, so a post
auto-hidden by the report threshold was reachable by anyone who typed a word of it
([moderation-and-blocking](docs/wiki/moderation-and-blocking.md#found-while-wiring-it-search-served-what-every-feed-refused)).
