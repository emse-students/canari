### Fixed - a slow swipe between tabs (and to the camera) no longer does nothing

The tab swipe locked its direction at 12 px, past Chrome's 8 dp touch slop, so a slow thumb's first move went unclaimed and Chrome took the touch. It now locks at 8 px ([design-reference](docs/wiki/frontend/design-reference.md#38-the-page-a-swipe-was-going-to-never-appeared-and-a-taps-drift-went-to-a-different-one)).
