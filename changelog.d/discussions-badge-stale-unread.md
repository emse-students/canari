### Fixed - the Discussions badge held a stale unread count

Two causes, both reported by the user: reading a conversation in one browser tab never told a
sibling tab, so its badge stayed lit until that tab read the conversation itself; and a system
notice merged from the FCM cache (e.g. the `memberAdded` notice an invite writes) counted as
unread even when the current user's own action produced it, since its sender is always `system`
rather than the actor. Tabs now broadcast a read, watermarked so a genuinely new message is never
swallowed by it, and the FCM merge now excludes system notices the same way the live path already
does ([chat](docs/wiki/frontend/modules/chat.md)).
