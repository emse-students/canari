### Fixed - a message sent into a group deleted before it is refused, never answered as delivered

The delivery service checked a group's tombstone only when it had rows to queue, and a deletion sweeps the roster, so a send into an already-deleted group answered 200 and wrote to its history; it now answers 410 there too ([latency](docs/wiki/frontend/notification-to-conversation-latency.md#f11---a-text-reply-no-longer-asks-the-server-whether-the-group-exists-before-sending-it-measured--01-to--017-s-per-reply)).
