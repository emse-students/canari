### Fixed - the in-app log says when a session's last lines may be missing

The on-screen marker is cleared only once the leave-screen write has settled, so a write that never settled is said at the next boot, neutrally, with the time the app left the screen ([mobile](docs/wiki/frontend/mobile.md#the-in-app-log)).
