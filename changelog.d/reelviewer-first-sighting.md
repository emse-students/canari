### Fixed - the reel viewer's lint warning

The once-per-item accusing log of the reel viewer kept a plain `Set` in the component, which the
reactivity lint flagged; a `createFirstSighting` helper now holds that non-reactive memory
([reels](docs/wiki/frontend/modules/reels.md)).
