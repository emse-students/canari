### Removed - `posts.pinned`, the retired global pin column (migration 134, held for the owner)

A pin is a row of `post_space_pins` per space since WP-PIN, and migration 128 carried the last global
pin; the column is dropped one release after it was unmapped ([spaces-and-audiences-reform](docs/wiki/spaces-and-audiences-reform.md#11-wp-pin---a-pin-is-a-promotion-per-space-not-a-global-flag-decided-2026-11-03)).
