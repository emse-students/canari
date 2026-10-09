### Fixed - the camera no longer asks "Discard this capture?" over the page you went to

Leaving the camera (a reel published, a tab tapped) drained the history stack with the same call as Back, so the review asked its discard question over the feed. A close handler now learns why it runs, and a navigation drops the take without asking. See [reels](docs/wiki/frontend/modules/reels.md#a-take-is-never-asked-about-once-the-screen-is-left-2026-10-09).
