## P2 - reading owed: the new-device alert posted once on the Mi 9T (2026-11-01)

The device-notice ledger's markers were refused by the filesystem (name too long) from
1.4.1-alpha.2 to 1.6.0, so the background engines never posted "a new device was added to your
account"; 1.6.1 names them by the key's SHA-256
([mls-protocol](../protocols/mls-protocol.md#new-device-notices-decided-by-the-user-2026-10-22-refined-the-same-day)).
The fix is proven by `cargo test` only. **Owed:** on the Mi 9T running the build that carries it,
with the app closed, add a device to the bench account, and read the local notification posted
ONCE (and not again on the next push or app open), with no `[DEVICE_NOTICE] marker ... not written`
line in the log. **And, right after the update and before the app's first open**, push a heal
commit naming an OLD device of the account: no "new device" notification may appear, and the log
must show the engine's `not announced by the background engine: the app has not pre-claimed` line
until the first open writes the pre-claim marker. Closes with that reading.
