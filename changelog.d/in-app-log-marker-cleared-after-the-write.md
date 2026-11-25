### Fixed - the in-app log reports a session killed while its last lines were being written

The on-screen marker is cleared only once the leave-screen write has settled, so a kill in between is reported at the next boot instead of losing the lines silently ([mobile](docs/wiki/frontend/mobile.md#the-in-app-log)).
