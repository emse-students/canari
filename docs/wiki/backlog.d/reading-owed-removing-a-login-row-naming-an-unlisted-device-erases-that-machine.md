## Reading owed - removing a login row that names an unlisted device erases that machine (2026-11-17)

target: 1.7.0

**What is built:** the cause of the 2026-08-23 partial restore is established from production's
tables - the old PC had never been revoked, its row only signed a login out
([auth](../frontend/modules/auth.md#why-the-old-pc-of-2026-08-23-came-back-with-its-store---established-2026-11-17)).
The device panel now revokes the device id a device-less login row names, unless it is the panel's
own (`revocableDeviceId`, [auth](../frontend/modules/auth.md#a-removed-row-whose-device-the-server-no-longer-lists)).
Proven by `deviceRowRemoval.test.ts` only.

**The reading that closes it:** on dev, two browser profiles of one test account, A and B. Make B's
device unlisted for A (delete B's `key_package` rows on the DEV database, ids into `WRITTEN-IDS.txt`),
then on A open the device panel: B shows as a login row; remove it - the confirmation is the
device one ("Supprimer ... de votre compte ?"). B is then wiped at its next exchange
(`[RESET] wiping this device back to a fresh install`, then `/login`), and its old id is on the
denylist. A's own row is never removable. A machine that keeps its store, or comes back under its
old id, is a FAIL.
