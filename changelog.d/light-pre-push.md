### Changed - the pre-push runs only its minutes-long checks

The pre-push keeps the path rules, the guards, lint and type-check and the tests the range reaches;
the services' jest suites, the crates' cargo test, `make test-ci-scripts` and the whole vitest suite
run in CI only (owner, 2026-11-16: speed first). See
[cicd](docs/wiki/cicd.md#checks-at-commit-at-push-and-in-ci-only).
