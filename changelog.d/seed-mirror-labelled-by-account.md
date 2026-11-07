### Fixed - one account's wipe now removes that account's Graine seeds from the push mirror, and only them

Each `graine_seeds.json` entry names the accounts that wrote it, so the deleted-account and revoked-device wipes, a community leaving the device and the retention sweep drop exactly what that account alone wrote; an entry written before the label goes with the install's only account and is otherwise never attributed to anyone ([auth](docs/wiki/frontend/modules/auth.md#the-seed-mirror-labels-each-entry-with-its-writers-2026-11-07)).
