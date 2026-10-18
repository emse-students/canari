### Fixed - refused calls of minesweeper, group invites, Adminer, the vault and the MLS publish/commit endpoints are typed

They throw an `ApiRefusalError` (status + code) instead of a plain `Error`, and the join page and the minesweeper score word it from the status ([architecture](docs/wiki/frontend/architecture.md)).
