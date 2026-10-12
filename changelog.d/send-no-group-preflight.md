### Changed - a text reply no longer waits for a server round trip before it is encrypted and sent

The outbox asked whether the group still existed before every send (a reply reached the other client 0.1-0.17 s sooner without it on the Mi 9T); the send itself is refused with a typed 410 for a deleted group, so the question is now asked only before a re-add or a media upload ([latency](docs/wiki/frontend/notification-to-conversation-latency.md#f11---a-text-reply-no-longer-asks-the-server-whether-the-group-exists-before-sending-it-measured--01-to--017-s-per-reply)).
