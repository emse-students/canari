## P2 - a history catch-up is thrown away because sends already past the gate land after its snapshot

target: 1.8.1

**Seen 2026-11-24** (a new web device, prod `1.7.3`, 2 min 20 s of restore): 17 lines
`[MLS] catch-up (<group>) state DISCARDED: the live client was mutated N time(s) since the snapshot`,
N from 1 to 14. Not an expected-on-a-new-device warning: the code itself calls the branch unreachable
(`WebMlsService.createDecryptSession`, "the gate in `sendMessage` should make this unreachable").

**The mechanism, read from the code.** `createDecryptSession` takes the MLS lock, closes the send gate
(`beginCatchUp`) and snapshots. `sendMessage` waits on that gate (`waitForCatchUpIdle`) only at its
TOP; it then awaits `settleBeforeSend` and the epoch barrier (`runAsEpochSend`) before the encrypt
counts the mutation (`emitFrame` -> `noteLiveMutation`). A send that passed the gate before the
catch-up opened is still in flight, and its encrypt lands after the snapshot: a check-then-act race. A
new device sends a frame per group per step (digests, register asks, welcome requests, read marks), so
the window is hit often. The swap is refused, which is the invariant doing its job, but the worker's
ratchet advance is dropped and its decrypt work wasted - a race that heals is still a defect
([durable-rules](../durable-rules.md)).

**The fix to build.** Count the sends between the gate and the end of `emitFrame` (in flight), and
have `createDecryptSession` close the gate, wait for that count to reach zero, THEN take the MLS lock
and snapshot - in that order, because a send in flight may itself need the lock (`settleBeforeSend`),
and holding the lock while waiting for it would deadlock. Check the nested-session rule of
`waitForMessageQueueIdle` (`openCatchUps`) against the new order.

**The test that closes it:** `BaseMlsService.sendSeam.test.ts` - a send parked between the gate and its
encrypt (a held `settleBeforeSend`) while a catch-up opens: the snapshot is taken only after that
send's encrypt, the install is not refused, and no `state DISCARDED` line is logged.
