### Fixed - the media index is written atomically, one write at a time

A crash or overlapping writes can no longer leave a truncated `media_metadata.json` that loses every entry at the next boot ([media-service](docs/wiki/services/media-service.md#retention-a-90-day-idle-sweep-on-chat-media-and-nothing-else-deletes-them)).
