### Changed - the frontend tests run under `node`, and only the 328 files that need a DOM get happy-dom

Two vitest projects (`node`, `dom`); the DOM list is seeded from a `--environment=node` run in `frontend/vitest.dom-files.ts`. Same cases, same pass set; measured in [test-suite-reform](docs/wiki/test-suite-reform.md#wp-t4-m---node-environment-by-default-happy-dom-only-where-a-test-needs-a-dom).
