### Fixed - a conversation no longer freezes on an entry no member made

The admission refusal of #2815 is disarmed before any release carried it: such a commit is merged and reported as before, no conversation is frozen and no message is dropped; the rule and what its fix-forward owes are on [mls-protocol](docs/wiki/protocols/mls-protocol.md#who-admits-a-new-person-2026-10-23).
