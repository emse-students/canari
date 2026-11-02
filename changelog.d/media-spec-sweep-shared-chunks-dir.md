### Fixed - a media-service spec no longer deletes another spec's staged upload

`media.service.chat-holds.spec.ts` ran the real orphan purge under a mocked future clock, wiping the shared `chunks_temp` of specs in parallel workers (a flaky `Upload session not found or expired` in the chat-reel spec); the purge is now stubbed there ([testing-methodology](docs/wiki/testing-methodology.md)).
