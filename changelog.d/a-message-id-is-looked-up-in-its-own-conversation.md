### Fixed - a message id shared with a peer's message in another conversation no longer patches the wrong row

The outbox and the reel-410 record looked a message up by id across all conversations and took the first hit, and an id travels to peers. They now look in the conversation the message was queued for (or the reel opened from), own rows only, and say so when no conversation is given ([outbox](docs/wiki/frontend/modules/chat.md)).
