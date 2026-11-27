### Fixed - a rebuild that fails leaves no transaction open, a kept copy never resurrects deleted rows, a close never overlaps an open, a dismissed biometric sheet is not logged as an empty keystore

The v23 rebuild's scripts recycle the connection pool on failure (never leaving it closed), the set-aside copy follows the user's deletions, `closeCachedStore` waits out an open of the same file, and a dismissed sheet carries its own code ([local-store-rebuild](docs/wiki/frontend/local-store-rebuild.md), [auth](docs/wiki/frontend/modules/auth.md)).
