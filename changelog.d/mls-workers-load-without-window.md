### Fixed - the web MLS workers load again, so a reload keeps its device

In `1.4.1-alpha.2` the three MLS web workers imported SvelteKit's page runtime through a byte utility and died at load, so the web client stored no MLS state and became a new device on every reload; a test now bundles and loads every worker in a worker scope ([mls-wasm](docs/wiki/frontend/mls-wasm.md#a-worker-loads-in-a-worker-scope)).
