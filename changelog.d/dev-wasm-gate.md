### Fixed - a dev deploy now refuses a wasm that can panic

`serve-dev.yml` runs `deployed-wasm-check.mjs` before the `dev-deployed` marker moves, so such a build cannot be promoted to a stable ([cicd](docs/wiki/cicd.md)).
