### Fixed - the picker's merge-duplicate integration spec now runs in CI

`picker-merging-duplicate.integration.spec.ts` (#4170) was skipped on every pull request because no `ci.yml` step set its database; it now has one beside the other core integration specs ([cicd](docs/wiki/cicd.md)).
