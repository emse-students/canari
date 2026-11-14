## P3 - what the offline cold start fix still leaves open (Mi 9T, `v1.2.9-alpha.1`, 2026-10-15; re-read 2026-11-11)

target: 1.8.0

Three of the four items from
[offline-and-weak-network section 15](../frontend/offline-and-weak-network.md#15-an-offline-cold-start-sends-nothing-it-knows-will-fail-2026-10-15)
are still true on `main`. The fourth, WP-HOLD-NOTHING, shipped (#2027); its bench reading is a row of
[the readings owed](../plan.md#readings-owed).

- **(b) The push context is not written again after an offline start.** `storeSessionPushContext`
  (`TauriMlsService.ts`) is fire-and-forget behind `getToken()`, and on an offline start that throws
  `TransportFailureError`. The catch logs and stops; the code comment says it is not retried at the
  reconnect. The native side keeps the previous launch's context until the next start. A retry on
  reconnect must first check that the device key has not changed meanwhile.
- **(c) Nothing re-asks our OWN other devices when one comes online.** `repair.ts` files the history
  as unanswerable for the epoch when only our own devices hold the group and none is online.
  `whenAnyComesOnline` watches USERS, and our own user is always online, so it would fire at once.
  The fix is a per-device presence waiter; the roster already carries `onlineDevices`. Until then the
  next start re-reads presence.
- **(d) A stale `navigator.onLine === false` can outlive a server outage.** A no-network spell ends
  on the reconnect (`online`, or any answered request) or on the return to the foreground. If the one
  spell refresh failed while the server was down, and the server comes back with no `online` event
  and no foreground, every later refresh is refused until one of the two happens.
