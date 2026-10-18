### Fixed - a mention of a deleted account reads "Compte supprimé"

`GET /api/users/batch` now names erased accounts in `deleted` (no name is kept) and the mention chip renders the deleted-account label ([core-service](docs/wiki/services/core-service.md#one-request-for-a-list-the-client-already-holds)).
