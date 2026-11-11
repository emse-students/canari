### Changed - CanaReels fetch the next 1-3 pages ahead, and a photo draws its ThumbHash before its file

The viewer fetches the first segment of the next videos (decoded into their first frame) and the next
pictures at once, three pages on a fast link and one on a slow one, without slowing the page on
screen. The player reuses those bytes instead of fetching them again. Photos are now published with a
ThumbHash, as videos are. A media download that nobody is waiting for any more - a reel scrolled past - is
now stopped instead of finishing in the background ([reels](docs/wiki/frontend/modules/reels.md#a-loading-reel-shows-its-first-frame-never-a-play-glyph-owner-2026-10-31)).
