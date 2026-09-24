### Fixed - two operator scripts still named the pre-migration box and compose project

`infrastructure/dev/copy-prod-to-dev.sh` and `infrastructure/local/pull-prod-dump.sh` still read
production as compose project `infrastructure` on host `canari`, both stale since the estate moved
onto `portail-etu.emse.fr` on 2026-09-24 and renamed the project to `canari-prod`
([estate-migration](docs/wiki/infrastructure/estate-migration.md)).
