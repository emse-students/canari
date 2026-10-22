### Fixed - a relayed seed reaches the sealed native mirror again

The check "does the mirror already hold this salon" read the file raw, and found nothing once the mirror was sealed, so every relayed seed was left to the app; it now reads through the one keyed reader ([mobile](docs/wiki/frontend/mobile.md)).
