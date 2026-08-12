# Legacy compatibility - what to delete once every client is current

Every entry here is a branch that exists ONLY to keep working against a client too old to speak the
current protocol. Each one is dead weight the day the last such client is gone, and each one is a
place where a future reader has to reason about two protocols at once.

**Why this file exists rather than a comment per site.** A compatibility shim is invisible once it
works: nothing fails, nothing warns, and the condition that would retire it is never re-checked. So
the condition is written down HERE, next to the thing it retires, and the removal becomes a decision
somebody takes rather than an archaeology exercise. Every shim below also carries a comment at its
site pointing back here.

**The gate is the same for all of them:** the store rollout has reached the devices, `minClientVersion`
has been raised past the release that introduced the replacement, and the fleet is confirmed on it -
not merely "the release is out". `minClientVersion` is the mechanism that makes the claim true: while
it sits below that release, an old client is not just possible, it is *supported*.

---

## Open

### `history_bundle` with no `to` - since v0.13.2

**Site:** `systemMessageHandler.ts`, the `history_bundle` branch.
**Shim:** a bundle carrying no `to` is accepted as an answer to OUR wait when
`isSolicitInFlight(groupId)` is true.
**Replacement:** every bundle is addressed at the requester's `digestIdentity` (`bundleFrame`).
**On removal:** drop the `isSolicitInFlight` fallback; an unaddressed bundle is then ingested for its
messages and discharges nothing, which is the correct reading of a frame that names nobody.
**Cost of keeping it:** small and non-lossy - it can only leave a marker up one exchange too long.

### `history_request` with no `withDigest` - since v0.13.2

**Site:** `actions.ts`, `handleHistoryRequest` (`requesterHasDigest`); relayed by
`messaging.service.ts`, `notifyHistoryRequest`.
**Shim:** an election frame without `withDigest` is read as "this client sends no digest", and the
responder answers immediately with its whole store.
**Replacement:** the requester states on the election frame whether a digest is coming, so the
responder waits for an EVENT instead of guessing at a duration.
**On removal:** make `withDigest` required in `NotifyWelcomeRequestBody`, drop the `= false` default
on `requesterHasDigest`, and delete the "client too old to send one" branch of the log line.
**Cost of keeping it:** a full-store dump per solicitation from those clients - bandwidth, never
correctness.

### `remove_reaction` as a system event - since v0.14

**Site:** `systemMessageHandler.ts` (live) and `historySystemEvents.ts` (replay), the
`remove_reaction` branches.
**Shim:** both branches translate the old frame into `applyReaction(..., removed = true)`, dated
with the entry's own delivery time because that frame shape carries no timestamp of its own.
**Replacement:** taking a reaction back is the SAME `ReactionMsg` that placed it, with `removed`
set - so both legs of one operation have one shape and both carry the `at` the merge orders on.
**On removal:** delete both branches, and drop `remove_reaction` from the silent-event list in
`proto_fields.rs`.
**What makes this one different:** no client sends the old frame after the rollout, but the shared
history stream still HOLDS entries written before it, so these branches are decoding data at rest,
not humouring a live peer. The condition to retire them is therefore the retention window elapsing
past the rollout, on top of the usual `minClientVersion` gate.
**Cost of keeping it:** a removal replayed from an old stream entry is ordered by its delivery time
rather than by the sender's clock. Only distinguishable if a placement and its removal were sent
within the same delivery, which cannot happen - the outbox serialises them.

### `read_receipt` naming message ids - since v0.14

**Site:** `systemMessageHandler.ts` (live) and `historySystemEvents.ts` (replay), the `read_receipt`
branches; and the per-message `readBy` / `readAt` still sitting inside encrypted rows written before
the change.
**Shim:** a receipt is translated into a watermark - the latest instant among the named messages
THIS DEVICE HOLDS. An id it does not hold contributes nothing, which is the only honest reading: the
frame names messages, and without one there is no instant to compare against.
**Replacement:** `read_watermark`, one monotone instant per participant merged as `max`. See
[history-reconciliation](protocols/history-reconciliation.md#read-state-becomes-a-watermark).
**On removal:** delete both branches and the `event === 'read_receipt'` half of their conditions.
Nothing else has to move - the stored `readBy`/`readAt` are already ignored on read, and the
watermark column is additive (SQLite v6).
**Same shape as `remove_reaction` below:** the shared history stream still HOLDS receipts written
before the rollout, so the branches decode data at rest, not a live peer. Retire them when the
retention window has elapsed past the rollout, on top of the `minClientVersion` gate.
**Cost of keeping it:** a receipt for messages this device never had reads as no read state at all,
where the sender did read something. It corrects itself on the next watermark that peer sends.

### `history_bundle` with no `vouched` - predates v0.13

**Site:** `historySolicit.ts`, `noteHistoryBundleReceived`.
**Shim:** an absent `vouched` is read as `true`, because every client shipped before the field sent a
bare `{ messages: [] }` exactly when it was entitled to vouch.
**Replacement:** `vouched: false` is explicit on a bundle from a responder that is itself awaiting.
**On removal:** default `vouched` to nothing and treat its absence as malformed.
**Cost of keeping it:** none measurable; it is a defaulting rule, not a branch.

---

## Closed

Nothing yet. Move an entry here with the date and the release that made it safe, rather than deleting
the entry outright - the next reader wants to know the shim existed and why it could go.
