### Fixed - a tab swipe no longer leaves the page shifted left

A drag whose touched element was re-rendered away never saw its release, so the page stayed parked at the drag offset on every later screen; the release is now heard on the element the touch started on ([design-reference](docs/wiki/frontend/design-reference.md#the-page-stayed-shifted-left-after-a-sideways-drag-on-every-route-2026-10-06)).
