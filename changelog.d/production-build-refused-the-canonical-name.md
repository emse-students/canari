### Fixed - the production web build refused `canari.emse.fr` and `v0.18.24` never reached the site

`build.yml` checked the baked backend against `DOMAIN: canari-emse.fr`, a name `serve-prod.yml` uses
for the LEGACY apex; once `BASE_URL` moved, the stable was refused as `unknown` while both stores took
it. Now `PROD_DOMAIN: canari.emse.fr` ([estate-migration](docs/wiki/infrastructure/estate-migration.md)).
