### Fixed - a salon message received in the background shows in the open salon on resume

The salon history cache is no longer trusted for five minutes; a socket drop or reconnect marks it
stale and the open salon reloads ([chat](docs/wiki/frontend/modules/chat.md#a-salon-copy-is-stale-when-the-live-stream-had-a-gap-never-when-a-clock-says-so-2026-10-01)).
