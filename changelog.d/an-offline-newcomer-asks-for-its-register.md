### Fixed - a new member offline when added gets the conversation's nicknames, and the join push no longer carries messages

A device that joins a group conversation now asks for the conversation's state, nickname register
included, with a sealed history ask. The inviter's push carries the state and no message, so a member's
history only ever travels sealed
([history-answer-addressing](docs/wiki/protocols/history-answer-addressing.md#the-newcomer-asks-for-its-register-2026-11-17)).
