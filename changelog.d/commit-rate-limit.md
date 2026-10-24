### Changed - seat claims and departures are serialised under one lock, and `POST /mls/commit` is rate-limited per user

Every write that creates, routes, queues to or evicts a key-group seat now shares one per-group lock, a commit an eviction overtook is refused whole and rebuilt by the client, and every key-group departure records its outcome (chat-delivery migration 036, social migration 108) ([channel-encryption](docs/wiki/protocols/channel-encryption.md#wp-21-and-the-gate-it-had-nowhere-to-live)).
