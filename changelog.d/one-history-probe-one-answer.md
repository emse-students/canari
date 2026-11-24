### Fixed - a device elected twice for one asker answers its history ask once

One history probe now wakes one waiting election instead of all of them, so a new device no longer
receives the same answer twice and refuses the copy at error
([history-answer-addressing](docs/wiki/protocols/history-answer-addressing.md#the-rules-as-built)).
