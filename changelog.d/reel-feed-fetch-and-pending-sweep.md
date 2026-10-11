### Fixed - a feed reel fetches only what it is about to play, and a failed reel publish leaves no blob

A feed card streams the head of a reel, then only what its playing video needs, and gives the stream
and its player back off screen; the decrypted media pool is capped by bytes. A reel upload whose post
was never created is swept a day later ([reels](docs/wiki/frontend/modules/reels.md#watching-the-feed-card-and-the-full-screen-viewer-c7), [media-service](docs/wiki/services/media-service.md#the-reel-pending-class-a-feed-reel-whose-post-does-not-exist-yet-2026-10-11)).
