### Fixed - a scheduled post no longer crashes the feed of those who may edit it

Since 1.6.12 the scheduled-posts strip called its card snippet without `@render`, so `/posts` crashed
("e.before is not a function") for every editor of a scheduled post until it was due. A scan now refuses
a bare snippet call in every `.svelte` file ([posts](docs/wiki/frontend/modules/posts.md#scheduled-posts-where-they-show-and-the-event-picker-order-2026-10-06)).
