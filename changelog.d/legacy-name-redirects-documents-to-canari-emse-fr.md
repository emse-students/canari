### Changed - `canari-emse.fr` sends every page to `canari.emse.fr` and keeps serving the apps

The legacy vhost now answers a document with a `302` to the same path on the new name, and still
proxies `/api/`, `/.well-known/` and the assets an open tab loads
([estate-migration](docs/wiki/infrastructure/estate-migration.md#a-browser-cannot-follow-a-redirect-and-keep-its-state---and-the-user-took-that-cost-knowingly-2026-09-25)).
