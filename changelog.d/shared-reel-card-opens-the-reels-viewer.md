### Fixed - a tap on a shared CanaReel's card opens the reels viewer, not the post page

The document's link handler navigated first and the card's own handler came too late; the card now owns its click ([sharing](docs/wiki/frontend/sharing.md)).
