## P3 - A device's revocation reset logs a `[seenHelps]` read failure at error level

target: 1.7.1

_2026-11-17: moved to 1.7.1 by the owner's 2026-11-17 scope cut ([decisions](owner-decisions-of-2026-11-17.md))._

Read on dev, `1.7.0-alpha.8`, 2026-11-17 ([readings](../device-verification.md#the-phone-readings-of-2026-11-17-170-alpha8-both-phones-one-sitting)): a web seat whose device its owner
removed from the device panel restarted, logged `session dead: a device was revoked by its owner`,
`[RESET] wiping this device back to a fresh install`, `[RESET] done`, and in between a
`console.error [seenHelps] reading the seen set failed SessionEndedByDeviceRevocationError`. The
revocation is the expected path and the reset its designed answer, so this line is noise at error
level: the seen-set read should recognise the typed session end (it is classified at the throw) and
stand down quietly, as the other readers of the reset do.
