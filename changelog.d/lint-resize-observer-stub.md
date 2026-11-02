### Fixed - the lint warning on the test ResizeObserver stub

`fireResize` now copies the observer set with `Array.from`, which passes `no-useless-spread` and keeps the same snapshot semantics ([test-harness](docs/wiki/testing-methodology.md)).
