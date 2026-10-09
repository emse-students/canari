### Fixed - the swipe to the camera did nothing on a fresh Feed after publishing a post

A modal closed by its owner's state (a publish) stayed on the history overlay stack, which stands the tab swipe down until a navigation drains it; it now leaves the stack when it closes ([mobile](docs/wiki/frontend/mobile.md#a-modal-closed-by-its-owners-state-left-the-overlay-stack-and-the-tab-swipe-stood-down-2026-10-09)). Owed one reading on the Mi 9T.
