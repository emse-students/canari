### Added - the media cache has a cap: 500 MB by default, 250 MB, 1 GB or unlimited in Settings, least recently used first and never a copy the server may no longer hold

The cached ciphertext grew without bound. A copy leaves only when the server confirmed holding it within 30 days; any other may be the only one left and stays, even above the cap ([media-service](docs/wiki/services/media-service.md#the-cached-ciphertext-has-a-cap-500-mb-by-default-lru-never-a-sole-copy-182)).
