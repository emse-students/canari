## P3 - A removed device replays the commits it missed and is answered 403, read as a replay error (CC-2, 1.4.1 dev campaign, 2026-10-25)

target: 1.9.0

The Remove commit the server queues to a removed device (`group:parting`) is built on the group's
CURRENT epoch, which is past the device's own whenever any commit landed between the server record
and the Remove - a lost commit race always does, and the rebuild of that race (2026-10-25,
[history-reconciliation](../protocols/history-reconciliation.md)) keeps it so. The device sees an epoch gap, runs rung 1 (`attemptCommitReplay` ->
`fetchCommitsSince`), and is answered `403` on `GET commits?sinceEpoch` - it is off the roster - with
`user-members` and `group-info` refused alike. `setupMessageHandler.ts` logs `[GAP] replay error ...
403` and keeps the gap clock running toward rung 2. **The 403 is an answer ("you are out"), not a
failure.** Owed: type it at the throw (`fetchCommitsSince`) and carry it to the `epoch-gap` arm, which
then hands it to `retireIfEvicted` rather than to rung 2. Gated on proof because retiring is
destructive: the roster 403 is not the device's own membership (`ExclusionsRefusedError` records that
trap), so the decision must read the server's own eviction evidence, not the status alone. Not built.

Re-read 2026-11-11 (batch 12): still real - `fetchCommitsSince` still throws an untyped refusal on a 403 (`mlsDeliveryApi.ts`, while `fetchGroupInfo` beside it types `NotAGroupMemberError`), and `setupMessageHandler.ts` still logs `[GAP] replay error`. Re-read again 2026-12-11.
