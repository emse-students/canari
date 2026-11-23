### Fixed - a flaky salon read test no longer polls a wall clock

`useConversations.salonReadAfterDrain` awaits a "drain was asked" promise instead of `vi.waitFor` with its 1 s default timeout ([channel-encryption](docs/wiki/protocols/channel-encryption.md)).
