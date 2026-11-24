### Fixed - a device elected twice for one asker answers its history ask once

One history probe now wakes one waiting election instead of all of them, and a late digest answered
for our own request is no longer stored for a second election, so a new device no longer receives
the same answer twice and refuses the copy at error; each refusal is now logged by its named cause
([history-answer-addressing](docs/wiki/protocols/history-answer-addressing.md#the-rules-as-built)).
