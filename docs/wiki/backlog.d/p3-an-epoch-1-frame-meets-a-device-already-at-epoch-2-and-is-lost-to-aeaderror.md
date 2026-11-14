## P3 - An epoch-1 frame meets a device already at epoch 2 and is lost to `AeadError` (DEV-6, `1.4.1-alpha.6`, 2026-10-26)

target: 1.9.0

This is a finding, not design. It is open until it is known why the frame arrives late.

Group `7820dd5c` is DEV-6's group. The first minted device (W3) is a member at epoch 1. At start-up,
while `WasmMlsClient::new` loads its state, it meets an epoch-1 application frame when the group is
already at epoch 2:

```
verbose [RUST::DEBUG] Sender data decryption error
info [RUST::WARN] Past-epoch application frame, unreadable for good: msg_epoch=1 group_epoch=2 group=7820dd5c-... err=ValidationError(UnableToDecrypt(AeadError))
info [21:28:49.670] [HISTORY] 7820dd5c… holds 1 frame(s) it can never read - reconciling (e.g. k1:137qgdw)
```

The second minted device (W6) reports the same frame key at 21:30:09. The invariant held, and HISTORY
reconciled the frame. The message is not lost to the user. The loss is on the MLS path.

The failure is `AeadError`, not `TooDistantInThePast`. The epoch-1 secret was still held, so the frame
could not be opened with a secret this device had at epoch 1.

What the console shows about the order: W3 took a Welcome into the group at 21:27:48. At 21:28:34 it
rejoined by its own external commit ("`[READD] ... roster seat with NO queued Welcome and NO add in
flight - nobody owes us anything; serving ourselves`", then "externalJoin succeeded ... (base epoch
1...)"). That rejoin is what took the group to epoch 2. The questions to answer:

- why a device that had just been Welcomed rejoined by external commit;
- whether the epoch-1 frame was encrypted before or after that rejoin;
- whether delivery order (the frame before the rejoin's commit) would have prevented the loss.

In the same load, the other groups show the expected case: frames older than the joiner's membership,
`TooDistantInThePast`. W3 logged 65 such lines. For example, six on group `1589de4c`:

```
info [RUST::WARN] Past-epoch application frame, unreadable for good: msg_epoch=2 group_epoch=54 group=1589de4c-... err=ValidationError(UnableToDecrypt(SecretTreeError(TooDistantInThePast)))
info [21:28:49.602] [HISTORY] 1589de4c… holds 6 frame(s) it can never read - reconciling (e.g. oz:hnqfta, jd:326tvj, ...)
```

Those `TooDistantInThePast` lines are the item already filed above (*A past-epoch frame older than
the joiner's own Welcome is logged at WARN*). This item is the `AeadError` alone.

**Plan (batch 14, 2026-11-12) - a finding to read, not code to write.** One rig row answers the three questions: DEV-6 re-run with the minted device's console and the server's `[COMMIT]` lines for its group captured, to read (1) why `[READD]` served a device whose Welcome had just landed - the roster seat check before the Welcome's merge was recorded is the first suspect - and (2) whether the epoch-1 frame was sealed after the external commit (an `AeadError` then means the sender used a secret of a branch this device never held). A fix follows the reading; MLS, so an agent of its own.
