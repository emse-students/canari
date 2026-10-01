### Fixed - the four notification-tap rows could not run, and their failure accused the product

`notif7.mjs` shelled out to a machine-local `a1.py` that never reached git, so NOTIF-7/-7b/-7c/-7d read `no shade row contains <marker>` for a missing script; `phone.tapNotification` now taps by element and records `SETUP-FAILED` on an instrument fault, and the runner answers under the board's own row ids. NOTIF-7 `PASS` 2026-09-22. [cross-client-testing](docs/wiki/cross-client-testing.md).
