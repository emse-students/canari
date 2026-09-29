### Fixed - the page a swipe goes to is now visible during the swipe, and a drifting tap no longer turns it

The tab gesture slid the old page off over an empty background and only then navigated, so the
destination was never on screen; the two now slide past each other in one motion. The commit rule
was a flat 60px, which a sloppy tap covers - it is now a quarter of the screen or a flick. A reply
swipe on a received message no longer also closes the conversation
([design-reference](docs/wiki/frontend/design-reference.md#38-the-page-a-swipe-was-going-to-never-appeared-and-a-taps-drift-went-to-a-different-one)).
