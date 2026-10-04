### Security - every salon message is sealed as Graine v2

A new session is endorsed by this device's MLS credential before its seed is distributed, every v1
session rotates at the next send, and each row carries the session's signature. The v1 writer is
deleted. See [channel-encryption §21.6](docs/wiki/protocols/channel-encryption.md#216-the-writer-wp-g2-5).
