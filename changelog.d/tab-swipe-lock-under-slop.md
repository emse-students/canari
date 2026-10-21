### Fixed - a slow swipe between tabs (and to the camera) no longer does nothing

The tab swipe locked its direction at 12 px, past Chrome's 8 dp touch slop, so a slow thumb's first move went unclaimed and Chrome took the touch. It now locks at 8 px ([design-reference](docs/wiki/frontend/design-reference.md#the-swipe-to-the-camera-that-sometimes-did-nothing-two-classes-measured-mi-9t-2026-10-21)).
