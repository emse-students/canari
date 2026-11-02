### Fixed - a write or a notification on a post follows the read's predicate

Reactions, comments, comment likes, mentions and reports on a post now ask the same gate as reading it by id (audience, block, moderation hide, schedule), and a scheduled post's mentions wait for its publication ([posts](docs/wiki/frontend/modules/posts.md#a-write-or-a-notification-follows-the-reads-predicate-2026-11-02)).
