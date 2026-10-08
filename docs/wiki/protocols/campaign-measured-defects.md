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
