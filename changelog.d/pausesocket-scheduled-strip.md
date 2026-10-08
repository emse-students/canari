### Fixed - no warning on every background, and the scheduled-posts strip empties on time

The paused native socket is released only when its disconnect frame was accepted, and `/posts` arms one timer on the earliest scheduled time. See [mobile](docs/wiki/frontend/mobile.md) and [posts](docs/wiki/frontend/modules/posts.md#scheduled-posts-where-they-show-and-the-event-picker-order-2026-10-06).
