### Fixed - a live replay's bar can be dragged back on the iPhone

A backward drag landed on the start of the buffered window (the replay keeps a minute behind the playhead on Safari), so the playhead did not move. A replay re-fetches whatever a seek lands on, so its bar is no longer clamped to the buffer ([live-replays](docs/wiki/live-replays.md)).
