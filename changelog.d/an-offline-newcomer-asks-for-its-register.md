### Fixed - a new member offline when added gets the conversation's nicknames, and the join push no longer carries messages

A device that joins a group conversation - in the app or, on Android, while it is shut - now asks for
the conversation's nickname register with a sealed history ask, until it gets it or no member can give
it. The inviter's push carries the state and no message, and is taken only from the inviter, so a
member's history only ever travels sealed
([history-answer-addressing](docs/wiki/protocols/history-answer-addressing.md#the-newcomer-asks-for-its-register-2026-11-17)).
