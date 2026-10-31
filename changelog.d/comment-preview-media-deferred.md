### Fixed - the feed no longer downloads every comment GIF at once

The collapsed comment's picture (#2801) was fetched and decrypted for every card the feed mounted; it now waits until the card is near the viewport, as a post's own attachments do ([posts](docs/wiki/frontend/modules/posts.md)).
