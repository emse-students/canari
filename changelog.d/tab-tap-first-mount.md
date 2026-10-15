### Changed - a tab tap no longer waits for a double tap or re-preloads every tab

The bottom bar answers a tap without Chrome's double-tap wait, each route's code is preloaded once per launch instead of after every navigation, and the feed no longer mounts its desktop-only conversations panel on a phone: tap to communities 453 -> ~343 ms on the Mi 9T, emulated ([community-open-budget](docs/wiki/frontend/community-open-budget.md#the-first-mount-profiled-and-cut-2026-10-15)).
