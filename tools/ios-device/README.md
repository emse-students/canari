# tools/ios-device

Drives and reads the bench iPhone from the workstation (bun scripts; `pymobiledevice3` on the PATH). Background in [cross-client-ios](../../docs/wiki/cross-client-ios.md).

| Script | What it does |
| --- | --- |
| `ios.mjs` | WDA driver: taps, element tree, screenshots, URLs |
| `install.py`, `sign-install.mjs` | install a build on the bench phone |
| `wda-daemon.py` | keeps the WDA session alive |
| `applog.mjs` | pulls the in-app log (page console of a store build) over `house_arrest`: `bun tools/ios-device/applog.mjs <out.txt> [--keep <dir>] [--db <hash>]` |

**`applog.mjs` handles message-bearing data.** The output and any `--keep` directory must be outside the repository (the script refuses otherwise); the temporary copy of the database is deleted at the end. The ring is written in batches, so the newest minutes may be missing. See [device-verification](../../docs/wiki/device-verification.md#the-iphone-12-readings-of-2026-11-16-170-alpha2-the-all-entries-sitting).
