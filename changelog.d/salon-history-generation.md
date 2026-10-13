### Fixed - an older salon history load can no longer remove a row a newer one decoded

Only the latest history load started for a salon merges its page; an older one finishing last used to drop a row inside its window that a newer load had just made readable ([chat](docs/wiki/frontend/modules/chat.md)).
