### Fixed - a CanaReel downloading on a slow link shows a spinner from the first byte

The viewer drew a static image icon for the whole download and the spinner only once the player mounted; it now draws the player's own spinner over the first-frame poster while the file arrives. The preload of the next reel keeps waiting behind the settled one, the reasons written down ([reels](docs/wiki/frontend/modules/reels.md)).
