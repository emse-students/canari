### Added - one reel file held by its post and its conversations (RC-14)

media-service keeps a reel file while a post or a conversation holds it; a salon message declares its reel (migration 122, approved by the owner) so a moderator purges only what their salon names; `reel-purge` carries its reason. Server half only, nothing sends to it yet ([media-service](docs/wiki/services/media-service.md#holds-one-file-for-the-feed-and-the-chats-rc-14-2026-11-01), [reels-in-chat](docs/wiki/frontend/modules/reels-in-chat.md#16-what-the-shared-file-server-package-rc-14-built-2026-11-01)).
