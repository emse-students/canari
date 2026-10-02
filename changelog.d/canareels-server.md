### Added - CanaReels, the server half: a `reel` post kind that deletes itself after a month

A reel is a post of `kind = 'reel'` with a declared duration (at most 90 s) and an expiry; an hourly worker deletes the post, its comments, reactions, notifications and every blob together, and `GET /api/posts/my-reels` tells its author which ones are about to go. Also fixes the community-message GC reading a DELETE's row count wrongly (its log line could never be written). See [reels](docs/wiki/services/reels.md).
