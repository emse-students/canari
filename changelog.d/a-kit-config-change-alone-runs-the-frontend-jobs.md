### Fixed - a change to `kit.config.js` alone now runs the frontend jobs

`ci-scopes.sh` fed `kit.config.js` to the production build only, so neither the vitest shards nor the push hook ran for it; it, `oxvelte.config.json` and `project.inlang/` now count as frontend changes, and `local-ci.test.sh` proves it ([cicd](docs/wiki/cicd.md)).
