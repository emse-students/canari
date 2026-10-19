### Added - lives: the segment seal, format v1

`frontend/src/lib/live/liveCrypto.ts` seals each live segment with AES-256-GCM under the live key, a fresh IV per segment, and the live id, index and format version bound in the AAD; a segment that does not open is a typed `LiveSegmentOpenError` ([live](docs/wiki/frontend/modules/live.md#the-segment-seal-format-v1)).
