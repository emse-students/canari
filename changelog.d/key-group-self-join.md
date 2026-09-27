### Security - Nobody can add themselves to a community's key group any more

A route meant for creating a conversation let anyone who knew a key group's id register themselves
into it, because such a group never has a member row for the gate to read; it now refuses every key
group ([channel-encryption](docs/wiki/protocols/channel-encryption.md#17-anybody-holding-a-key-groups-id-could-add-themselves-to-it---fixed-2026-09-27)).
