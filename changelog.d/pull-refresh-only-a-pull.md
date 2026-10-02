### Fixed - Pull-to-refresh claims only a downward pull

A sideways swipe from the top of the feed is left to the tab swipe, and a move the browser already scrolls is no longer cancelled, which logged a console error on every swipe ([design-reference](docs/wiki/frontend/design-reference.md)).
