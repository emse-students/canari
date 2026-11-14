## P2 - what the key-package claim fix left: the sweep claims before reading the tree, and the empty-pool WARN fires once per serve

target: 1.10.0

The storm of 2026-11-06 and the fixes for it are in
[key-package-pool](../protocols/key-package-pool.md#a-read-is-not-a-claim---the-empty-pool-storm-of-2026-11-06):
#3060 (the sweep and the `welcome_request` answer claim one device, the own-publication read peeks),
then the account list's `?peek=1` with `listUserDevices` for every roster reader, and a claim never
shared in flight. What is left, in order:

- **Owed: one production read of the `[KP] one-time pool EMPTY` rate a week after the stable that
  carries the list peek** (read-only, `docker logs` of chat-delivery-service). Installed clients
  below it keep claiming on their roster reads until they update, so the rate falls as they do; a
  rate that stays high with the population upgraded names an adder, and the line names the device.
- **The pending sweep claims before it asks whether the device is already a leaf.** A fulfilled
  invitation is vouched and the claimed package is discarded. The tree read needs no package, but
  moving it first changes the order against the refusal cleanup (a revoked device already in the
  tree would be vouched rather than its row deleted), so it needs a decision and a test of that case.
- **Still refilled only at connection** - [backlog](p2-a-device-s-one-time-keypackage-pool-is-topped-up-only-when-it-connects.md).
  A new device admitted to more than 50 groups in one sitting empties its pool by design, and the
  rest of its Welcomes share the static row's init key.
- **The `[KP] one-time pool EMPTY` WARN fires once per serve**: 176 lines for one device on one
  night. The transition into the empty state is the fact, and the rate against the population is the
  measure. Report it once per device per empty episode, plus an hourly count against the devices
  served, once the refill-while-connected item has made an empty pool rare. Today the line is the
  only witness, so it stays as it is.
- **P3 - `awaitOwnKeyPackagePublished` peeks once per group**: about 131 requests on the connection
  measured here. Remember `published` until the next key-package round settles, and peek again only
  then.
