### Found - avatars are edge-cached since 2026-09-16, and batching them would now be a regression

A Cache Rule took each avatar from ~900 ms to 17-37 ms; one batched JSON answer would add base64 and lose the per-image cache entries that made it fast ([core-service](docs/wiki/services/core-service.md#the-avatar-proxy)).
