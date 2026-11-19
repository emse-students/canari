### Fixed - a replay played to its end now ends instead of halting before the last frame with a spinner

The player declared the end of the stream once and remembered it, but the engine reopens an ended source on any `remove` or `append`, and the trim behind the playhead did exactly that. The end is now declared whenever the source is open at the end of the list ([live-replays](docs/wiki/live-replays.md#a-replay-reaches-its-end-the-engines-state-is-the-memory-of-ended-2026-11-19)).
