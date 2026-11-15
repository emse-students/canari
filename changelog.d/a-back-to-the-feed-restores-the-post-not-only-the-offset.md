### Fixed - a Back to the feed puts the same post back, not only the same number of pixels

On the Mi 9T a feed left at 1500 px came back at 1726 once content above it had settled differently. The
page now remembers the first visible post and its distance from the top, and aligns that post on Back
([section-navigation](docs/wiki/frontend/section-navigation.md)).
