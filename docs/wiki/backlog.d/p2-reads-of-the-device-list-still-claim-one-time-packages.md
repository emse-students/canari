## P2 - reads of the account device list still claim one-time KeyPackages, and an empty pool still warns once per serve

The storm of 2026-11-06 and the two paths fixed for it are in
[key-package-pool](../protocols/key-package-pool.md#a-read-is-not-a-claim---the-empty-pool-storm-of-2026-11-06).
What that fix left, in order:

- **`GET mls/devices/:userId` claims one package from every device it lists**, and these callers use
  none of them: the settings security section, the device management panel, the new-device notice
  wiring (twice: the device's name, and the pre-claim of old devices at registration), and
  `sendWelcome` without a device id (it needs only the ids). The fix is the same `peek` on the list,
  with a client method that reads the roster without packages. The callers that do use every package
  (group creation adding every device of a person, `admitNewcomer`) keep claiming.
- **The pending sweep claims before it asks whether the device is already a leaf.** A fulfilled
  invitation is vouched and the claimed package is discarded. The tree read needs no package, but
  moving it first changes the order against the refusal cleanup (a revoked device already in the
  tree would be vouched rather than its row deleted), so it needs a decision and a test of that case.
- **Still refilled only at connection** - [backlog](../backlog.md#p2---a-devices-one-time-keypackage-pool-is-topped-up-only-when-it-connects-measured-2026-10-25-after-the-stable).
  A new device admitted to more than 50 groups in one sitting empties its pool by design, and the
  rest of its Welcomes share the static row's init key.
- **The `[KP] one-time pool EMPTY` WARN fires once per serve**: 176 lines for one device on one
  night. The transition into the empty state is the fact, and the rate against the population is the
  measure. Report it once per device per empty episode, plus an hourly count against the devices
  served, once the refill-while-connected item has made an empty pool rare. Today the line is the
  only witness, so it stays as it is.
