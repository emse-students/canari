### Changed - a live's key is stored encrypted at rest

Social-service now keeps each live's key sealed under the new required secret `LIVE_KEY_ENCRYPTION_SECRET` (migration 110); the live sweep seals rows written before it ([lives](docs/wiki/services/lives.md#the-live-key-at-rest)).
