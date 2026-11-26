## The touch answer names the server's idle window per object, so the media cache cap stops guessing

target: 1.8.3

The media cache cap ([media-service](../services/media-service.md#the-cached-ciphertext-has-a-cap-500-mb-by-default-lru-never-a-sole-copy-182)) treats a copy as evictable only when the server confirmed it within 30 days, a constant, because the idle window is an admin setting (1-3650 days) the client cannot read. Make `POST /api/media/touch` answer, per id, the window that object was stamped with (`idleRetentionMs`, or absent for a class the sweep never takes), record it in the ledger beside `confirmedAt`, and let `planEviction` compare against it. Charter principle 2 ([principes](../../principes.md)). A test: a confirmation inside the answered window is evictable, one outside is kept, whatever the constant says.
