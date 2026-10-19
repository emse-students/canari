### Added - lives: the segment seal, format v1

`frontend/src/lib/live/liveCrypto.ts` seals each live segment with AES-256-GCM under the live key, a fresh IV per segment, and the live id, index and format version bound in the AAD; a segment that does not open is a typed `LiveSegmentOpenError`. It protects against the media store, the cache and a leaked URL, not against social-service, which serves the key ([live](docs/wiki/frontend/modules/live.md#the-segment-seal-format-v1)).
