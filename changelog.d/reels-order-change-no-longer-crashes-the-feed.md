### Fixed - switching the CanaReels order from deep in the stream crashed the feed page

A change between "Pour toi" and "Récents" now replaces the viewer's whole list at once and every slide keeps its own post, so the slide torn down no longer reads the new list at its old place; and a failure inside the viewer now closes the viewer with a message instead of the feed ([reels](docs/wiki/frontend/modules/reels.md#the-order-of-the-stream-and-a-change-of-order-is-a-new-list-owner-2026-11-10-crash-fixed-2026-11-11)).
