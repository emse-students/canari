### Fixed - an Add whose answer was lost no longer leaves its invitee off the conversation

The server now enrols the people an Add admits in the same transaction that accepts the commit, so an Add settled by a later resubmission or sent from the offline outbox enrols its invitee like any other, and a Welcome the roster refuses is no longer re-sent at every connection ([mls-protocol](docs/wiki/protocols/mls-protocol.md#an-add-enrols-its-people-with-the-accepted-commit-2026-10-25)).
