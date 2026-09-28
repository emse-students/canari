### Fixed - a key group behind its server stayed frozen, and its seeds and requests went out at an epoch nobody could read

A held key group is now compared with the server's epoch after the drain and caught up by replay, one commit at a time for a frame from a future epoch; nothing is sealed while it is behind ([channel-encryption](docs/wiki/protocols/channel-encryption.md#221-a-key-group-behind-its-server-catches-itself-up-and-nothing-is-sealed-while-it-is-behind)).
