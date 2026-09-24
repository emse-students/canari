### Removed - the old box's stopped rollback containers and volumes

23 stopped containers (12 prod + 11 dev) and 10 named volumes on the old `canari` box, kept as a
rollback copy since the estate migration, deleted by explicit user consent now that the target has
run both estates stably. The target is the only copy from this point on
([estate-migration](docs/wiki/infrastructure/estate-migration.md#canari---moved-2026-09-24-it-was-two-estates-and-a-ci-runner-not-one-estate)).
