### Changed - a cold start no longer decrypts every stored message to check a history cursor

The restore asked "is this conversation's store empty" by decrypting all of its rows; it now counts them, so 5000 stored messages cost ~3 ms instead of ~170 ms per conversation on a desktop ([cold-start](docs/wiki/frontend/cold-start.md#the-restore-decrypted-every-stored-message-to-read-a-length-2026-10-12)).
