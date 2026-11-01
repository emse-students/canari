### Fixed - iPhone notification outcome log: a run that ends during the app's read is no longer counted `killed`

A dead run's marker becomes a `killed` line only when the app's own removal took it, runs are named by `(pid, at, n)` so two in one millisecond stay two, and a refused append logs its true cause ([mobile](docs/wiki/frontend/mobile.md#what-the-extension-did-in-the-apps-log-2026-11-01)).
