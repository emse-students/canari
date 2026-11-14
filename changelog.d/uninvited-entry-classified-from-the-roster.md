### Fixed - a member's own new device is no longer reported as a new person entering a conversation

`[UNINVITED_ENTRY] kind=new-person` fired when a member's new device joined a conversation by itself and the reporting device had seen no departure of that member. The classifier now asks the server's roster: an admitted seat is a member coming back (`returning`), never a new person ([mls-protocol](docs/wiki/protocols/mls-protocol.md#who-admits-a-new-person-2026-10-23)).
