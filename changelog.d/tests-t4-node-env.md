### Changed - the frontend tests run under `node`, and only the 391 files that need a DOM ask for happy-dom

Each declares it on its first line (`// @vitest-environment happy-dom`), seeded from `--environment=node` runs; `src/test/environment.test.ts` fails a DOM test that forgot it and a pragma anywhere but line 1. Same cases, same pass set; no speed claim yet ([test-suite-reform](docs/wiki/test-suite-reform.md#wp-t4-m---node-environment-by-default-happy-dom-only-where-a-test-needs-a-dom)).
