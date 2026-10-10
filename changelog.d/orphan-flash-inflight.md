### Fixed - a large attachment no longer flashes "Cet envoi n'a pas abouti" while it is being queued

The sender now says an enqueue is in flight, so the orphan card waits for the durable row instead of reading its brief absence ([media-frame](docs/wiki/frontend/media-frame.md#7-an-orphan-media-row-and-a-card-with-no-bubble)).
