### Fixed - a community key group no longer gets a conversation row, nor a roster 403 at boot

A key group's Welcome is no longer announced to the conversation layer nor, with its server row unreadable, taken for a conversation; discovery reads a group's kind before asking its roster ([channel-encryption](docs/wiki/protocols/channel-encryption.md#a-key-groups-welcome-wrote-a-conversation-row-and-discovery-asked-its-roster---fixed-2026-10-25)).
