# MLS state, healing and delivery - what the campaign measured, and what it refuted

The reasoning, numbers and recurrences behind the open MLS entries of [backlog](../backlog.md). The
backlog keeps a title, what is left and a link here; the story of how each defect was found lives
below so that nothing has to be re-measured. Entries are independent and run in the order the
backlog lists them. Shipped fixes are in `CHANGELOG.md`, not here.

## The read-receipt probe, and two instrument problems (2026-09-05)

The notification half of the visibility fix was verified on the device (shade carries the decrypted
text 2 218 ms after the send, LIFE-2 `FAIL` -> `PASS`). The read-watermark half was not. It is the same
one-term guard reading the same `isAppInForeground()`, whose value WAS measured flipping correctly on
hardware, so the residual risk is that the watermark path behaves differently, not that the fact is
wrong.

- **`openConversation` cannot be a precondition on a phone already inside the conversation.** It waits
  for the peer's row in the SIDEBAR, and on a mobile layout the list and the conversation are different
  screens, so it reported `listedEntries: 0` for 3.5 minutes about a client sitting in the very DM it
  wanted. A screenshot settled it in one look; it was one step from being filed as "the phone's
  sidebar comes back empty after a reinstall".
- **A raw `/api/mls/send` count is the wrong observable.** The watermark is a control frame among
  other control frames, and the probe's positive control came back ZERO in the foreground where a
  watermark IS owed, so the run was correctly `INCONCLUSIVE`. Whether that zero is "already at its
  target" (`if (target <= held) return`), a watermark sent before the observer attached, or a path the
  probe does not see, is not established.
- **What a real row needs**: the peer's view. W2 holds the read state of its own message; `A1 read it`
  appearing for a message nobody looked at is one DOM read on W2 against a marker, falsifiable in both
  directions without counting anything.

## HEAL-W2's break cannot take (2026-09-06)

The row makes a group unknown by restoring an MLS blob that predates the join. On `60432d09` the
restore was immediately undone: `digest after restore` and `digest after reload` differ, which is the
discriminator the runner already carries - the live app checkpointed its in-memory state back over the
restored blob. `brokeForReal: false` records `SETUP-FAILED`, which is correct. The work is arranging
for NOTHING to execute between the restore and the load, and two obvious ways fail: parking on
`about:blank` changes the origin so `mlsdb.mjs` cannot reach the `localhost:8081` IndexedDB, and
`Emulation.setScriptExecutionDisabled` freezes the restore tool's own `Runtime.evaluate`. A
same-origin document that boots no app (a static text path) satisfies both; whether IndexedDB is
scriptable from one is the thing to measure. A second, independent gap: `markerReason: UNRESOLVED
GROUP ID` - the runner could not map the group NAME to its uuid.

## Five rows watch a responder heal a device that no longer needs one (2026-09-06, 2026-09-07)

`HEAL-NEW-11`, `-12`, `-15` were written for a product where a fresh device sat AMBER until some member
served it. They wait up to 90 s for an "amber alone" state, then start the responder. On `c643a411` that
state never arrived (`never went amber alone within 90s: rows 36, ready 36, syncing 0`, watch opened
122-166 s after live).

- **HEAL-NEW-1 explains it and is a PASS**: with the phone force-stopped, both browsers down and the
  gateway confirming `extra: []`, a fresh device reaches 36 of 36 ready in 8.0 s through the
  external-join seam (`roster seat with NO queued Welcome and NO add in flight - nobody owes us
  anything; serving ourselves`). A device holding a roster seat does not need a responder.
- **The late watch is a symptom, not the fault.** Moving the arming point would only make the rows fail
  faster. The question becomes askable again with a group the device CANNOT let itself into - one it is
  owed a Welcome for rather than one it holds a seat in. The product distinguishes them in its own log
  (`already in tree for <id> - skip (will join via queued Welcome)` against the self-service line), so the
  discriminator exists; the fixture that puts the subject in that state deliberately does not. A rung
  redesign, not a row edit. `healnew.mjs` forbids "a second probe invented to rescue it".
- **MULTI-9 is the fifth.** Asked what a message sent to a `pending` device is worth once it activates.
  On its first ever execution the new device reached `active` in 105 ms because the owner held five
  devices in the group and one committed the add immediately: 5 of 5 messages arrived at an ACTIVE
  membership, so the row proved nothing about its question. It records `VACUOUS` for exactly that case
  (the window itself being the sole unmet expectation) and never for the two failures it must not
  absorb: a device that never activates, and a message lost in a window that DID exist.
- **The window came back once, on 2026-09-08**: all three rows passed clean on `9cf5191cc`, watch opened
  24.2 s after live. One record is one draw, and a premise that returns unexplained is not restored.
  Owed: why the device sat amber there when it self-serves in 8 s on HEAL-NEW-1, and a re-run showing the
  window is reliable.

## Twelve of sixteen messages fetched and dropped, the hole at epoch 121 (prod, 2026-09-02)

DM `7da231f8`: of sixteen messages the peer sent, the Android phone fetched all sixteen and displayed
four. The four causes (a best-effort commit-log insert outside the epoch-advance transaction,
`getCommitsSince` blind to a hole (`gapAt`), a `pending` sender accepted and fanned out
(`403 sender_not_active`), and application frames emitted between a device's own commit and its
acceptance (`epochSendBarrier`)) are fixed and stop the NEXT loss; none recovers these twelve.

- The twelve: plaintext exists only on the peer's iPhone, and the ciphertexts on prod are past
  `max_past_epochs(2)`. A diff against that iPhone is the only recovery.
- **Which arm of `process_message` dropped the 13:10 four is not established**, and the logcat cannot say
  retroactively. **Do not write a fix against a suspected arm**: the candidates in
  [messaging.rs](../../../frontend/mls-core/src/messaging.rs) are the epoch-gap fast-fail, the past-epoch
  application arm and the same-epoch refusal, and they carry different fixes. Settling it needs a
  reproduction with `clearLogcat()` first, through [phone.mjs](../../../tools/cross-client-harness/phone.mjs)
  and the `LOGCAT_TAGS` in [verify-on-device.py](../../../tools/android/verify-on-device.py).
- The "SECURISE & SYNC" shield that lied here is gone; the panel says only "Chiffre de bout en bout",
  by the user's choice to stop exposing the machinery. Whether a device that dropped a frame should say
  so anywhere is NOT decided.

**CLOSED 2026-10-09 as a defect; what remains is unrecoverable by construction.** The hourly
`reportCommitLogHealth` read 11 groups and 18 missing epochs in every one of 11 reports over 32 h of
production, the newest hole dated 2026-08-31 (before the four fixes shipped): no hole has appeared since
and none has grown. The twelve plaintexts exist only on the peer's iPhone, and the arm that dropped the
13:10 four cannot be established retroactively - a fix written against a suspected arm is exactly what the
text above forbids. The standing ERROR line is the DESIGNED front of that report (a new hole lands first
and the known ones age out with the retention floor), so it is not a second defect. The one question
left, whether a device that dropped a frame should say so, is parked in
[open-questions](../open-questions.md#should-a-device-that-dropped-a-frame-say-so).

## A new device's join reaches the commit gate before its KeyPackage (2026-10-09)

**The two sections below ("holds a distribution group the group holds no row for" and "refused for want of a KeyPackage") are ONE defect, and its cause was read from production on 2026-10-09 - the other end of the exchange included.**

What the server logged in the previous 32 hours (`canari-prod-chat-delivery-service-1`): six `[MEMBERSHIP_ACTIVE] REFUSED ... reason=no_key_package`, on four groups, **all four COMMUNITY distribution groups (`distributionWorkspaceId` set) and no conversation**. For each of the six devices the sequence is the same, inside one or two seconds: `[PURGE_PREKEYS] deleted=0` (the first thing a fresh start's key package round does) -> `[COMMIT] START` for the community group -> `REFUSED no_key_package` -> the commit's own `[SEND] ... isCommit=true` accepted -> **`[REGISTER_DEVICE] START ... isNew=true`** -> `[SEND] sender has NO membership row` on the first application frame. The gate (`deviceAddressability`) answers an activation for a device with no static KeyPackage and writes no row; `REGISTER_DEVICE` then creates `pending` rows (`pendingGroups=N`) for a device that is already in the tree and will never be sent a Welcome.

**Why the order inverts.** The community loader calls `ensureDistributionGroupFor` as soon as the page holds the community, and the device's key package round (mint, checkpoint, publish) runs beside it. The worker mint holds the MLS lock for its own span only, so the join takes the lock the instant the mint lets go and commits one checkpoint and one HTTP round trip ahead of the publication.

**What it cost, measured.** Three of the six rows became `active` later (2 min, 35 min and 1 h 44 min after the refusal - the 1 h 44 one on an iPhone, which meant seeds unrouted for that long); the other three devices have no rows now (deleted devices). The stranded-membership report showed one pending row past its window for about eleven hours on the same day.

**The fix, first form (#1666, in `v1.2.2-alpha.1` and NOT in `v1.2.1`):** when a key package round is running, the join awaits it; a failed round answers the typed `{ joined: false, reason: 'key_package_round_failed' }`. It left two holes: a join that starts BEFORE the round has set `keyPackageRoundInFlight` saw no round, and a round whose request never answered held every join of the group.

**The fix, second form - the join waits on a PUBLISHED FACT (2026-10-10, reviewed adversarially and corrected the same day).** `BaseMlsService.awaitOwnKeyPackagePublished` reads the server's own statement that this device holds a static KeyPackage - `GET /api/mls/devices/:u/:d/key-package`, an existing route that answers from the row `deviceAddressability` checks, classified by `keyPackagePublication()` (an ELAPSED package counts as published: the gate checks presence). Read on EVERY join, never cached: a cache of "published" goes stale when the server deletes the row. Each pass captures a monotonic settle count BEFORE the read:
- published: join.
- a round settled while the read was in flight: the answer predates it, so read again (the LOST WAKE-UP of parking on a stale "absent" for a round that already came and went); if that round failed and none runs, the failure is the answer.
- a round is running: park until one settles, then read again. A failing round refuses nobody while an overlapping one still runs (the counter is `keyPackageRoundsActive`, not the single in-flight field).
- absent (or revoked, which a round re-enrols) with NO round running: the join STARTS the round - the only thing that can make the fact true - and waits for it. Parking would wedge for ever (a row deleted server-side, no boot/republish/replenish coming) and, through `externalJoinFlights`, hand every later caller of the group the same hung promise. If the round succeeded and the server still does not hold the package: `own_key_package_unverified`, never a second round.
- unreadable with no round running, or no device key yet: `{ joined: false, reason: 'own_key_package_unverified' }`, the detail of the unanswered read logged.
`destroy()` wakes every parked join (they refuse `own_key_package_unverified`) and clears the group flights. A failed round answers `key_package_round_failed`. No timer. **Not built:** clearing a cache on a gate `no_key_package` (there is no cache; and nothing relays that answer to the client on the join path - only the server log and the membership-active push see it).

**The one clock, and why the rule allows it.** Every HTTP call of the round (`register-device`, `register-device/prekeys`, the prekey count and purge, and the fact read) now has a per-request deadline, `KEY_PACKAGE_REQUEST_DEADLINE_MS` = 60 s, which aborts the request and throws the typed `DeliveryDeadlineError`. **The prekey count PROPAGATES it and fails the round** - read as `0`, both platforms would have minted and published a full pool of fifty against a server that never answered, the deadline becoming a heal. The purge keeps its `[]` (nothing may be forgotten) but is logged at error level; the fact read answers `unanswered`. It turns a hang into a failure and does nothing else: no retry, no proceeding, no healing - the round fails, tells its caller, and the waiting joins refuse with a type. Generous because it bounds a hang and does not time a transfer. **The whole round is bounded too (2026-10-10, second review).** The per-request deadline bounds HTTP only; a native `invoke` (`generer_key_packages_et_persister`), a mint under the MLS lock or a re-enrolment cannot be aborted and kept the active-round count above zero, so every join parked. `generateKeyPackage` now races the round against `KEY_PACKAGE_ROUND_DEADLINE_MS` (180 s, above a 22 s PIN-unlock checkpoint): the caller stops WAITING and the round fails with `DeliveryDeadlineError`, the count is decremented, the waiters are woken. No retry, no heal. **What the abandoned work may still do:** finish its mint, persist up to 50 bundles and publish, logged when it ends. **What the next round does:** it reads the server's pool count (`fetchPrekeyCount`): if the late publish landed it is 50 and nothing is minted; if the first round stopped between persist and publish (including a `register-device/prekeys` timeout after the native mint) the count is low and a SECOND batch is minted, the first batch orphaned locally until `prune_expired_key_packages` - **a double mint CAN happen**, bounded by that prune and identical to the cost of any failed publish after a mint (`republishKeyMaterial` has always had it). Not fixed: closing it needs the native side to report unpublished persisted bundles, which is its own work package. A join's re-read is bounded by a PASS COUNT (6 reads per attempt, a counter), the unverified warning is emitted once per distinct reason (repeats are debug), and `recovery.ts` asks no member for a Welcome while `own_key_package_unverified` or `key_package_round_failed` stands, since a Welcome is built from the very KeyPackage that is missing. Boot passes `''` as the device key in biometric mode, and the self-started round passes the same value. Tests: `BaseMlsService.joinAfterRegistration.test.ts` (written red first: the join that begins before the round, the elapsed package, the unreadable fact, the cache) and `mlsDeliveryApi.roundDeadline.test.ts`.

**Measured on prod 2026-10-10 (read-only, `canari-prod`, window since the `v1.2.1` deploy at 13:13 UTC).** Community key-group external joins (commit log, MLS sender type 4, groups in `channel_workspaces`/`channels` `distributionGroupId`): 33-96 per day over 2026-09-27..10-08 (median about 69), 82 on 10-09, and 30 between 13:18 and 22:36 UTC on 10-09 (about 77/day pace). **`v1.2.1` did not move the number, and it should not have: #1666 is NOT in `v1.2.1`** (it is in `v1.2.2-alpha.1`, dev only); `v1.2.1` carries #1686, which is about a native cold start re-joining groups it already holds. `[MEMBERSHIP_ACTIVE] REFUSED no_key_package`: **2 in the 9.7 h since the deploy, both on community key groups, both of a new device with the PURGE_PREKEYS -> COMMIT -> REFUSED -> REGISTER_DEVICE sequence** (web 1.2.1 on Windows at 20:01 UTC, iOS 1.1.0 at 20:46 UTC) - the unfixed behaviour, as expected. `[SENDER_MISMATCH]` and any `REFUSED` in `canari-prod-chat-gateway-1`: 0 (that line is client-side; nothing server-side carries it); 0 `SENDER MISMATCH` in chat-delivery either. Logs cover only since the container start (13:13 UTC), 10-09 - so the comparison to the 32 h before it is 2 vs 6.

**Owed after it ships in a stable:** the same read; `REFUSED no_key_package` on a key group of an `isNew=true` device must be zero for devices on the fixed version (a device on an older version keeps producing it until the floor moves).

## A device holds a distribution group the group holds no row for (2026-08-29)

Handed back by HEAL-NEW-15's branch on `038c7e8d`, deliberately unacted on. Sixty seconds after
external-joining the community distribution group `315b8a1d` at epoch 56, the fresh device logged `this
device holds the distribution group but the group holds NO row for it (3 device(s) for this user) - the
local group is stale, rejoining` and joined again at epoch 57.

- **A race that heals cleanly is still a defect**; the thing to find is what makes the two paths overlap.
- `315b8a1d` was the ONLY group of eleven the reconciliation did not ask about (`10/11 group(s) asked in
  794 ms`) and the only one external-joined twice (56->57, 57->58) before the late responder arrived.
  Whether the skipped reconciliation is a consequence of the absent row or a second symptom of the same
  stale state is undetermined, and is the first question. One `GROUP BY` over
  `dm_device_group_memberships` for this device and group settles which row existed when.
- **Recurrences**: both rows of the 2 / 12 pair on `038c7e8d` (15:09:47 and 15:14:31, community
  `fbddc890`, each external-joining `315b8a1d` twice and no conversation group, reconciliation asking 0
  of 1 and 0 of 2 - so the "only group not asked" correlation cannot be tested at that fleet size);
  HEAL-REVOKE-5 on `96bdd1bb` at 23:00:52 with `(3 device(s))` and 23:02:55 with `(2 device(s))`, two
  counts in one run tracking the live population. The community is the constant, the count is not. The
  population is wider than "freshly minted": a device RETURNING from a revocation wipe produces it too.

## A membership refused for want of a KeyPackage one second after the external join (2026-08-29)

Seen twice in HEAL-NEW-15 on `dc8bf000`: the client logs `externalJoin succeeded`, about a second later
the server logs `[MEMBERSHIP_ACTIVE] REFUSED ... reason=no_key_package` for the SAME group, and the
membership goes active shortly after. What must be named first is which ordering is real - a KeyPackage
published after the external commit, or an activation read running before the publication it depends on
has committed. The discriminator is the publication's own timestamp against the refusal's; both exist.
It cost nothing because W1 was online; nobody has measured the population where nothing is.

- **Recurrences**: both rows of the 2 / 12 pair (refused 13:09:20, active 13:09:47 = 27 s; refused
  13:13:36, active 13:14:31 = 55 s), always the community distribution group `315b8a1d` and never a
  conversation. **Treat "are the stale-group entry and this one a single defect" as the first question.**
  HEAL-REVOKE-5 on `96bdd1bb` at 21:00:41 on the seed device: no `[MEMBERSHIP_ACTIVE]` line at all,
  explained by the row (the seed is revoked ~90 s later), so the absence is not a refusal that never healed.
- **Invisible from the client half**: `healnew.mjs` records only `observers: { w3 }`; the server window is
  printed by `run.mjs`, not written to the ledger row. A HEAL-NEW verdict says "clean on the web client",
  never "clean on the server".

## The Welcome livelock - the residue (prod, 2026-09-01)

Six causes, all fixed (story in `CHANGELOG.md`): `pending` read as an in-flight Add (`welcomeQueued` +
`addInFlight`), the kick writing `pending` before the Add landed (`MlsError::NoSuchMember`), `stale_base`
answered with a Welcome instead of a republish (`staleBase.ts`), a failed re-add reported nowhere
(`kickedAt` + the hourly ERROR arm), a device still holding the group skipping the seam
(`recoverRosterDisagreement`), and a fallback KeyPackage dying at its first Welcome (`last_resort`,
[mls-protocol](mls-protocol.md#the-two-kinds-of-key-package)). `4f87267a`, the original witness, is no
clean probe any more (no device could open it on 2026-09-12 until its other member returns).
`[KICK] Stale leaf` still appears locally (HEAL-REVOKE-5, 2026-09-06 01:03) and is the local
reproduction to take the measurement against. **Its blast radius is measured on the HEAL-repair P1: a
kicked leaf is elected as a history responder like any other member and is silently a dead end - the
rotation fix was REFUTED 2026-09-08, not to be re-opened.**

**CLOSED 2026-10-09 by the prod reading the entry owed.** `reportStaleExternalJoinBases` said *every
published base names the current epoch of its group* in 33 of 33 hourly runs, and
`reportStrandedDeviceMemberships` read `0 kicked with no re-add` in all 11 runs that found a pending row
(the others found none); the table read zero pending rows of 1470 on 2026-10-09. The local `[KICK] Stale
leaf` sighting stays as a reproduction pointer, not a defect.

## A roster seat without a Welcome - the typed reason (prod, 2026-09-01)

The inviter carries a typed reason per skipped KeyPackage (`SkippedKeyPackageReason`; mechanism in
[chat-delivery](../services/chat-delivery.md#a-roster-seat-is-not-a-key-and-only-a-welcome-tells-the-two-apart)).
The hourly `reportStrandedDeviceMemberships` still partitions on the queue because the reason lives only
in the inviter's console. Closing it is a client-to-server write (endpoint plus a column or table keyed
by device and group), i.e. a migration. Two facts to settle with it: the client CANNOT say last-resort vs
one-time (the extension is unreadable on a refused package; the server, which chose the row, would have to
record which it served), and the first `skipped` lines from real inviters say whether a spent OTK pool
(the original hypothesis: all four of the peer's web devices showed 0 one-time packages) or a rejected
package is the cause. Read those before designing the write.

## The placeholder and the MLS tree

The defect, guards of 2026-08-28 and hand cleanup of 2026-08-30 are in `CHANGELOG.md` and on
[chat-delivery](../services/chat-delivery.md#the-placeholder-that-took-a-conversations-first-seat-cleaned-by-hand-2026-08-30).
The server estate is zero on all four tables; MULTI-8 `PASS` 2026-09-07 measured the live behaviour
clean. A server row is not the MLS tree: if a commit ever Added the placeholder only a Remove commit from
a member drops it. The group `7da231f8-119c-4ce2-884f-55f5c94c903f` sat at epoch 118 and the placeholder
held a `key_package`, so an Add is likely rather than certain. Either member can read the tree from their
own client; until then the conversation may be encrypting to a member that does not exist, which costs
nothing cryptographically and makes the roster wrong.

## A group that never leaves its creation epoch keeps collecting invitations (prod, 2026-08-30)

Found by HEAL-REVOKE-7 `--order last` on `edb8d7ab`: `equalityGap: ["rows: 12 vs 13", "syncing: 0 vs
1"]`. The extra group `8868be1c` was alive (`deletedAt` null, `activeEpoch 1`) with memberships: the
creator `active` (written when the creator registers itself, never revisited) holding NOTHING 291 ms
later, and three devices `pending` for ever, one minted an hour later. **A membership row records that an
invitation was SENT; nothing reads back whether it was honoured, and nothing expires it.**

The population, measured 2026-08-30 before the sweep (pending rows on LIVE groups by age, `GROUP BY` over
`dm_device_group_memberships JOIN dm_groups`): `< 1h` 2 rows / 2 groups; `< 1 day` 9 / 5; `< 7 days` 13 /
5 - so 22 of 24 pending rows were older than an hour, 13 older than a day, none pointed at a revoked
device. Of nine live groups at epoch 0 or 1, four carried pending rows and three were real conversations
(two DMs from 2026-08-03 and 2026-08-28, one unnamed group from 2026-08-28; the oldest 33 days old),
untouched deliberately.

- **Do not take `activeEpoch <= 1` for the predicate.** Pending rows exist on healthy groups too (epochs
  3, 4, 5, 8, 10, 108, 258 each had one), and a DM created and never written to legitimately sits at
  epoch 1 with everyone `active`. The corpse is a `pending` row that outlived any plausible delivery - a
  duration, measured against the population before a name is put on it.
- **It reaches a HEAL row that is not about it**: a FRESH device creates a row for an unservable group and
  leaves the tile amber for ever; a RETURNING device creates none. Rung 16 asserts "a returned device ends
  where a fresh device ends".
- **Three things want deciding together**, the third cheap: whether an invitation expires, whether a group
  whose creator holds no state is still offered, whether an unservable group shows a tile at all. Never
  by widening a sweep: the P1 that destroyed `8868be1c` is what a destructive path does from an
  incomplete read.

**CLOSED 2026-10-09 by the population.** The first decision already shipped: an invitation expires
(`cleanupStalePendingInvitations`, keyed on `pendingSince`). Production read ZERO `pending` rows of 1470 on
2026-10-09 (and none on a live group at epoch 0 or 1), the hourly `reportStrandedDeviceMemberships` found
at most one in the last 32 h and it healed, and that report is the watcher if the shape comes back. The
other two decisions have no population to decide about.

## A re-admitted device calls its own exclusion window a loss (2026-08-26)

Found by a fix working: GRP-8's round-2 re-admission Welcome used to be dropped as a redelivery
(`e027679a`), so the re-admission never happened on the joiner. With it processed, the SAME frame is
judged twice and the answers disagree, 15 s apart on `feecfaf5`: `Frame arrived after this device was
evicted - ACKed and dropped, no repair is owed` (msg_epoch=3 group_epoch=3), then `[WELCOME] held but
EVICTED - re-admission` -> epoch 4, `Past-epoch application frame, unreadable for good: msg_epoch=3
group_epoch=4` and a `[HISTORY_RECONCILE]`. `history.ts`'s `kind === 'evicted'` branch carries the
argument (*we are not entitled to the plaintext, so there is nothing to recover*) but is keyed on the
CURRENT membership, so it stops applying the instant the device is re-admitted while the frames it
protects are still in the stream. **A column is only evidence for the question it was written to
answer**: `evicted` is "am I out NOW", not "was I out THEN". Cost: one reconciliation per re-add over the
whole exclusion window, scaling with its length and the group's traffic.

- **The fix**: an ENTITLEMENT FLOOR per group written where the Welcome installs (the
  `readmittedAfterEviction` branch of `setupMessageHandler.ts`); a frame below it is handled like
  `evicted`. The frame's own epoch is not visible from JS (`SecretTreeError(TooDistantInThePast)` carries
  no number). Either surface it through the decrypt error (never learn by failing what a fact could have
  told you) or key the floor on the STREAM POSITION at re-admission, since the replay walks rows in order
  and row ids are timestamps - which needs no WASM rebuild and no APK.
- **Recurrence 2026-08-30, widening the population**: six HEAL-REVOKE-5 runs (`96bdd1bb` to `0044a041`).
  The device losing frames was never evicted - a fresh device of the same user joining after a revocation
  wipe - so the floor cannot be keyed on `readmittedAfterEviction` alone: **a floor belongs at every
  entitlement START**. GRP-8 as the confirming check is incomplete for the same reason.
- **Measured**: 107 distinct `LOST frame` fingerprints over the six runs (1, 8, 8, 9, 30, 51), 50 of 51 in
  ONE group of the owner's 23. The fingerprint's first field is `frame.length` in base 36: median 52 KB, max
  84 KB, 5.6 MB total. A second larger population sits behind the same group in aggregate (`holds 8005
  frame(s) it can never read`, then 3005; `5p` = 205 bytes, small frames), with example fingerprints
  identical across the three observers of one run.
- **The inference that must NOT be drawn**: no fingerprint repeats across runs, which is NOT evidence the
  frames are new messages. `frameFingerprint` is FNV-1a over the CIPHERTEXT and `historyManifest.ts`
  answers a reconciliation by re-encrypting the durable copy at the CURRENT generation, so the same
  message re-sent fingerprints differently every time. A reading of it as "fresh traffic each run" was
  formed and retracted.
- **The cheap discriminator**: the digest asks with nothing held (`[HISTORY_DIGEST] Sent for 642f389a... -
  ids mode, 0 id(s), asking from 2026-05-31T00:00:00.000Z`), so whether the 52 KB frames ARE that answer is
  settled by putting the `Sent` stamp beside the burst, which lands inside one second. If the
  reconciliation's own answer arrives unreadable, the repair is feeding the loss it was sent to cure.
  Also unqueued: `[HISTORY_RECONCILE] no probe sender yet - 642f389a... deferred until one is installed`,
  five times across two groups before the first digest.
- The policy question behind it: [open-questions](../open-questions.md#is-a-remove-meant-to-be-durable-against-a-later-re-add).

## A device revoked while OFFLINE keeps its store until someone logs in on it (2026-08-30)

HEAL-REVOKE-9 asserts three things: while the victim was severed (4 ms) and revoked from the owner's
panel (`stillAddressable: false`, 2 106 ms) its state was still there (`identityKeys: 1`, 2 databases, 22
localStorage keys, `wipeRan: false`). **A device that cannot ask does not conclude**; a wipe there would
have been the rung's worst outcome. A reload changed nothing (`footprint.mjs` read 6.54 MB fourteen
minutes later); one `login.mjs --device W3` took it to `identityKeys: 0`, 3.46 MB. The wipe is DEFERRED,
not lost: `sessionAuth.ts` has three triggers, each needing a credential or a live socket, by design
(wiping on an unauthenticated page visit is a destructive control firing without a confirmed server fact).

What stays open is a DECISION on how long the residue may sit - on a machine never logged into again (the
stolen-laptop case) it stays indefinitely. It is an identifier (`mls_device_id_<userId>`) plus SEALED key
material (`canari_device_key_vault`) over databases encrypted under that key: ciphertext and a name, not
readable messages, hence P2. Both ways out are bad: asking the revocation route at the login GATE means
answering `/api/mls/devices/:userId/:deviceId/revoked` to an unauthenticated caller (a device-enumeration
oracle); the alternative is a local expiry, the clock this project refuses to make load-bearing.

## The presence poll (logcat, 2026-09-02)

Read off the Pixel 6a: 45 `GET /api/presence` in seven minutes, one every ten seconds
(`createPausableInterval(checkPresenceNow, 10_000)` in `presenceStore.ts`, still so on 2026-10-04), on a
client already holding a live WebSocket. The `pong` WARN half is fixed (`isHeartbeatFrame`). A push needs
a DESIGN DECISION first: who may watch whose presence, the question `get_presence` in
`apps/chat-gateway/src/presence.rs` already names (today any authenticated caller may ask about any user
id). Then it is a gateway subscription plus a client listener replacing the interval.

## The Android background/resume sequence (2026-09)

A backgrounded Android WebView stays `visible` ([durable-rules](../durable-rules.md)). The cheap sites
already take the native edge (`onAppForegroundChange`). What must move TOGETHER, and only after one run on
a phone because the pieces depend on each other:

- `ChatBackgroundService.svelte` `handleVisibilityChange`: on hidden it pauses the socket, flushes and
  releases the native foreground guard (`pause_mls_foreground`); on visible it reloads `mls.bin` into the
  warm engine before anything processes. On Android neither half runs today.
- `createPausableInterval` drives the `mls_foreground_heartbeat` that keeps that guard alive. Pausing it on
  the native edge ALONE would let the guard expire while the resume reload still never runs - a warm
  engine overwriting a background engine's advance (`SecretReuseError`). It also drives the presence poll.
- The visibility guards in `ChatBackgroundService.svelte` and `MainChatPage.svelte`, and the version check
  on return in `routes/+layout.svelte`.

The run: on the Mi 9T, background the app with the WebSocket up, wait past the guard's 30 s, send it a
message, bring it back, and read whether the background engine delivered, whether the warm engine
reloaded and whether the socket paused. The switch also changes how a backgrounded phone is notified
(socket paused -> FCM), which the 2026-09-05 notification fix rests on.

## Mentions

- **A mention of a deleted account** (2026-09-08): `GET /api/users/<id> -> 404` is written by the browser,
  not the app (the client already caches the 404 for 30 s). Two designs remove it: the server answers
  **200 with a tombstone** (`deleted: true`, no name), or the mention carries a **name snapshot** taken
  when written (the only one that survives the server forgetting the user). Never silence it with
  `ignoringExpectedLog` on the row: the same shape is how an unminted identity in a roster shows.
- **A mention banner says "someone"**: the hex is gone from every native composer. The name instead of the
  word is a design choice: the MLS path cannot be told server-side, the device already holds names
  (`peekUserDisplayName` / `seedUserDisplayName` in `utils/users/displayName.ts`), so the cheap shape is a
  mirror like `graine_seeds.json` (a Rust command plus its `capabilities/` grant, a call site in the
  resolver, a Kotlin and a Swift reader), no network on the push path. The channel path could take the
  first mentioned name from the server, bounded against the 4 KB APNs budget (`push-payload.ts`). A miss
  keeps today's word.
