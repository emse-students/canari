### Fixed - a live replay's bar can be dragged backward

A backward drag of the bar out of the buffered window landed on the window's start (the replay keeps ten seconds behind the playhead), so the playhead did not move. A replay re-fetches whatever a seek lands on, so its bar is no longer clamped to the buffer ([live-replays](docs/wiki/live-replays.md)).
