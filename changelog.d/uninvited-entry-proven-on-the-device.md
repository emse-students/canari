### Fixed - a member coming back to a conversation is recognised by the device itself, never on the server's word

`[UNINVITED_ENTRY] kind=new-person` fired when a member's new device joined a conversation by itself and the reporting device had merged no departure of that member. Each device now records, in its sealed MLS state, who it saw hold a leaf of each conversation; an entrant it saw before is `returning`, anything else is reported as not proven, with where its record starts ([mls-protocol](docs/wiki/protocols/mls-protocol.md#who-admits-a-new-person-2026-10-23)).
