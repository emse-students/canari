### Fixed - an outbox retry no longer re-encrypts the queued file

A backoff bump now updates the clear scheduling columns in place; it used to decode and rewrite the whole payload, which on a Pixel 6a swung the renderer from 160 MB to 1.4 GB every minute ([backlog](docs/wiki/backlog.md)).
