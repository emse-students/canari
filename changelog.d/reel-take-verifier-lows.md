### Fixed - a chat-reel take's release and its tab hand-offs are never silent (RC-13 follow-up, writer still off)

A failed `releasing` write is retried in the same page life, a reel deletion lost between tabs is re-derived from its tombstone by the leader, and the take records are kept by the leader only ([reels-in-chat](docs/wiki/frontend/modules/reels-in-chat.md#17-what-the-multi-target-outbox-rc-13-built-2026-11-01)).
