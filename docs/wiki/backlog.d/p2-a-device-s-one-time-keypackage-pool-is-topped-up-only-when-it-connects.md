## P2 - A device's one-time KeyPackage pool is topped up only when it connects (measured 2026-10-25, after the stable)

target: 1.9.0

The server serves a joiner's one-time KeyPackage from a per-device pool and falls back to the
static last-resort row when the pool is empty (`[KP] one-time pool EMPTY ... serving the static
last-resort row`). The client refills the pool in one place: on each socket connection, as tab
leader, it asks for its count and mints up to 50 (`generateKeyPackage`, web and native alike).
Nothing tops it up during a live connection, and nothing tops up a device that never connects.

Measured read-only on dev during the `1.4.1-alpha.4` replay. Every group an account creates admits
all of that account's devices, so each one spends a package per group.
- The seats the rig reloads before each row held 25 to 41.
- A phone that stayed connected for about 2 h 30 after its last top-up held 0. Its log shows one
  publication, then only token refreshes and no reconnection.
- Two idle browser profiles held 0.
The server fell back to the static row for all three. So replenishment works, and it is outpaced by
design: the fallback becomes the routine path for any device that stays connected through more than
50 joins, or that is not connected.

A fallback is a signal, not a path. What is owed:
- top up while connected, either on a low count or on a signal from the server that a package was
  consumed;
- decide what an idle device's empty pool should mean;
- keep the empty-pool WARN as the accusing line it is.
Not before the stable.
Re-read 2026-11-11: still real - the pool is refilled to 50 only at publication on a connection (`WebMlsService.ts`, `TauriMlsService.ts`), and the `[KP] one-time pool EMPTY` WARN still serves the last-resort row (`devices.controller.ts`). Re-read again 2026-12-11.
