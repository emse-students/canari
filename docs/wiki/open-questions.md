# Open questions

**No code until they are answered.** Every item here is a QUESTION, not a defect: it has no severity,
and its first task is to produce an answer. That is why they are not in
[backlog](backlog.md) - that file is the scheduled queue behind `CLAUDE.md`, and a question mixed into
it reads like work somebody forgot to do.

**What happens to an answer.** It either becomes an entry in [backlog](backlog.md) with a severity, or
it closes the question and the section is deleted from here - with the reasoning going to the wiki page
that owns the subject, never left only on this page. A question that has been answered and still sits
here is the same defect this split was made to fix.

**These are owed to the user, not to the code.** Several can only be answered by a decision that is
theirs (what a Remove is meant to guarantee, whether an app is worth building), and the rest need a
measurement or a device nobody here has. None of them is waiting on an implementation.

---

### DECISION OWED - may a drain that only RECEIVED application frames skip its full checkpoint? (2026-10-13)

**ANSWERED 2026-10-18 (user): yes, but ONLY after the Mi 9T crash measurement below.** The work package is [WP-CHECKPOINT-SKIP](backlog.md#decided-by-the-user-on-2026-10-18---every-design-question-answered); this section stays as the measured reasoning and the protocol, and is deleted when the measurement is read and the build ships.

**What happens today.** Every drain ends with a full encrypted checkpoint of the WHOLE MLS state,
even a drain of one application frame. `mlsStatePersister.onBulkIngestEnd` sets
`dirtyEncrypted = true` unconditionally, overriding the commit/application split
`setupMessageHandler` makes (`persistNow` vs `scheduleDeferred`).

**Measured.**

| Mi 9T, native (`heavy_state_checkpoint` cross-built for aarch64) | 0.48 MB | 1.9 MB | 3.8 MB | 7.7 MB |
| --- | ---: | ---: | ---: | ---: |
| one decrypt | 0.55 ms | 0.48 ms | 0.49 ms | 0.49 ms |
| export + seal | 2.7 ms | 11.7 ms | 25.6 ms | **49.3 ms** |

The file write and the IPC come on top. On native the manager mutex is held across the export and
the seal (performance-audit finding 12), so a send or a decrypt waits for all of it. On the bench
account's small state the app logged 5-96 ms per checkpoint. On web the cost is the seal plus
IndexedDB: 198 ms at 7.7 MB legacy, 47 ms with the v2 seal
([performance-audit](frontend/performance-audit-2026-10-12.md#finding-2-and-3-read-together---the-checkpoint-question-the-backlog-owed)).
Per frame, the checkpoint costs about 100 times the decrypt it follows.

**What a crash then costs at the MLS layer** (`mls-core/tests/deferred_receive_checkpoint.rs`). The
on-disk state is BEHIND by the frames received since the last checkpoint. The three tests show:

- every one of those frames decrypts again from the restored state: a re-read, never a loss;
- the next frame from that sender decrypts, and this device's next send is read by its peers;
- the bound is the sender ratchet window (`maximum_forward_distance` = 2000, `group.rs`): 1990
  unsaved receives still recover.

Three things are out of scope: commits, which `persistNow` checkpoints at once under any policy; this
device's own sends, which are checkpointed on the send path; and the replay marks, which are already
bound to the checkpoint (`commitPendingHistoryMarks`).

**Why this is a decision and not a fix.** Skipping the checkpoint WEAKENS durability. A process
death leaves `mls.bin` behind by up to N received generations. The MLS layer recovers from that, but
three app-level consequences are not measured:

1. **The seen-cipher ledger is written per frame** (`noteFrameConsumed`, `localStorage`). After a
   crash it can say "read" for a frame the restored state could still read. The rows for those frames
   are written at the same drain end as today's checkpoint, so nothing new is lost. The open part is
   that a replay skips the frame. This is the safe direction of TAB-3b; the defect it fixes runs the
   other way ([history-reconciliation](protocols/history-reconciliation.md#a-cold-start-re-accuses-frames-it-already-read-the-mark-must-be-one-write-with-the-advance-tab-3b-measured-2026-09-08)).
2. **The native resume reload would see `live-ahead` on most resumes instead of rarely.** It then
   refuses the reload and persists the live state, which discards whatever the background FCM engine
   wrote to `mls.bin` meanwhile (`TauriMlsService.reloadStateFromDisk`). Whether that loses a frame
   the background engine read AND acknowledged is the question to measure first. The background
   flush (`mlsStatePersisterLifecycle`, on the native foreground edge) runs before the engine
   starts, but it is not awaited.
3. **Forward secrecy at rest.** The keys of frames already read stay on disk until the next
   checkpoint. The plaintext rows sit on the same disk under the same device key, so the exposure is
   believed to be nil. That is a judgement, not a measurement.

**The proposal, if the user takes it.**

- `onBulkIngestEnd` checkpoints only when the drain set `persistNow` (a commit, a Welcome, a
  structural change).
- A receive-only drain marks the state dirty and leaves it for the next trigger that already exists:
  a send, a commit, the background edge, logout.
- A COUNT bound, never a clock: a checkpoint is forced after K deferred receive generations, with K
  well under the 2000 window (for example 200).
- Lever one (the v2 seal, writer OFF) cuts the web side about four-fold with no change in
  semantics, and should be switched on first.

**Not built, deliberately.** Item 2 must be measured on the Mi 9T before any of it:

- kill the app (`am force-stop`) with deferred receives pending;
- push frames while it is dead;
- resume, and read the log for `live-ahead`, duplicates and `unreadable for good`.

**The measurement switch (2026-10-18, inert).** No build holds a state ahead of the disk, so the
protocol above cannot be run as written. `mlsStatePersister` takes a `receiveSkipBudget` (default 0 =
today's behaviour, pinned by a test), read by `receiveCheckpointSkipBudget`
(`mls-client/receiveCheckpointSkip.ts`) only on a development-estate build AND with an explicit
`canari_dev_checkpoint_skip_k` key:

- It skips ONLY a LIVE drain (`bufferUi`) that never called `persistNow` (so never a commit, a
  Welcome or a structural change) and whose window overlapped no history replay or restore, which
  save a stream cursor and seen hashes of their own and must never get ahead of the MLS state.
- The budget counts application FRAMES (ratchet generations, one `scheduleDeferred` each), not
  drains: a catch-up drain of hundreds of frames reaches it and checkpoints at once. The cap (500)
  stays under `maximum_forward_distance` (2000).
- A failed write restores the urgency it was covering, so the retry is not skipped, and no skip is
  decided while an urgent checkpoint is still in flight.
- Frames read outside the conversation path report themselves (`noteReceivedFrame`): a key-group
  commit is structural (never skipped), a key-group seed or a frame refused for its sender spends a
  counted generation, and a partial gap replay (`applied > 0`, not healed) asks for a checkpoint.
- **The real worst case** is K-1 skipped frames plus the size of the drain that reaches the budget
  (that drain checkpoints, but a kill during it loses it): with the cap of 500 that stays under
  `maximum_forward_distance` (2000) while a drain stays under ~1500 frames.
- It logs at warn on every skip. An explicit `flush` (background, logout, send) writes as before.
- **To use it on the Mi 9T:** `VITE_DEPLOY_ENVIRONMENT=development` must be set before
  `bun a1apk.mjs --debug` (the bench build does not set it, and a store tester WebView is not
  inspectable), then set `localStorage.canari_dev_checkpoint_skip_k` through the devtools socket.

**MEASURED on the Mi 9T, 2026-10-22 (switch ON, local estate, bench accounts, dev debug build of
`main` at the merge of #2078): NO FRAME LOST, NO `live-ahead`, NO DUPLICATE, NO `unreadable for good`
in 6 valid switch-ON trials (plus a switch-OFF control), up to 60 skipped frames.** One DM between two bench accounts; the
peer (Chrome) sends `live` frames while the phone is open, the app is `am force-stop`ped, the peer
sends `dead` more, the app is relaunched and unlocked. Read from `adb logcat` and from the DM.

| trial | K | live | dead | on the phone after resume | live-ahead | duplicates | unreadable for good |
| --- | --- | --- | --- | --- | --- | --- | --- |
| control, switch OFF | 0 | 5 | 3 | 8 of 8 | 0 | 0 | 0 |
| ON | 20 | 5 | 3 | 8 of 8 | 0 | 0 | 0 |
| ON | 20 | 15 | 5 | 20 of 20 | 0 | 0 | 0 |
| ON (budget crossed once) | 20 | 25 | 5 | 30 of 30 | 0 | 0 | 0 |
| ON, DM open | 100 | 60 | 10 | the newest 60 of 70 (the pane renders 60) | 0 | 0 | 0 |
| ON, phone parked on the feed | 100 | 40 | 10 | 50 of 50 | 0 | 0 | 0 |
| ON, log read | 100 | 10 | 3 | 13 of 13 | 0 | 0 | 0 |

- **The skip really happened.** The log carried one `MEASUREMENT SWITCH ON: checkpoint skipped ...
  (N/100 frames unsaved)` line per frame, N counting up to 60 at the kill, and no checkpoint line in
  between. With K=20 and 25 live frames the 21st frame checkpointed (24 skips plus the init line).
- **After the resume only the frames pushed while DEAD were decrypted** (10 `Message decrypted` lines
  for 10 dead frames, none for the 40-60 live ones): the server does not redeliver what the phone had
  consumed, and the stale ratchet decrypts the later frames by moving FORWARD, which is what
  `maximum_forward_distance` (2000) allows. A lag of a few hundred frames is far from that bound.
  The disk lag itself is INFERRED from the skip lines, not read from the file.
- **A valid ON trial needs the key held after the restart.** A first "ON" run read the key back as
  `null`: the WebView had not flushed `localStorage` before `am force-stop`. Wait ~5 s after the
  `setItem` and assert the key after the relaunch, or the run is a second control.
- **What this does NOT cover:** a kill DURING a drain of more than K frames (the worst case above), a
  kill with a commit in the window (structural, never skipped by construction), K of 200-500, and a
  phone that stays killed for hours. The decision to build is the user's, on these numbers.
- **The device:** the phone carried the RELEASE build 1.3.1 (first install 2026-10-13 23:37:42, last
  update 2026-10-21 00:25:39); it was uninstalled ON PURPOSE on 2026-10-22 to install the debug build,
  which destroyed that install's enrolment and MLS store (a bench phone, Master's yes). The debug
  install is a NEW device (2026-10-22 01:46:27) with the bench owner on the local estate.

### DECISION OWED - should a read receipt wait for a COUNT or an event instead of the 2 s window? (2026-10-15)

Since the sender coalescing, a DM or group watermark is sent when the 2 s window after reading ends,
when the reader leaves, or when the app leaves the screen. The window is the mechanism's one clock.
If it were wrong the cost would be more traffic, never a lost receipt. Under the "termination from a
proof, never from a clock" rule, that still makes it load-bearing. The alternatives change what a
peer sees:

- **events only** (leave, background, the next send): a DM peer sees "Vu" only once the reader leaves
  or replies;
- **a count K**: the frame goes after K foreign messages read, so "Vu" lags by up to K messages.

Measured gain first: the frames left after the own-send half was removed
([history-reconciliation](protocols/history-reconciliation.md#the-sender-says-only-what-is-new-and-the-outbox-keeps-one-watermark-per-conversation-2026-10-15)).
A device count of watermark frames per minute of active reading would size what is left to take.

### DECISION OWED - should the KeyPackage pile leave the blob every checkpoint rewrites?

**Measured 2026-10-13** ([store-phone-reading](frontend/store-phone-reading-2026-10-13.md#4-the-mls-state-rewritten-in-full)):
a store Pixel 6a holds 15.5 MB of MLS state, ~6 MB of it 2535 KeyPackage bundles, and every native
checkpoint re-encodes, re-seals and rewrites all of it. A bundle never changes once minted - it is
written once and only ever deleted - so that share is rewritten for nothing. On a desktop, the same
80-group state checkpoints in 16-20 ms and in 27 ms once 2535 bundles are added (4.8 MB, +60 % of
the bytes, +40-70 % of the time); a phone's number is not measured.

**Why it is a decision and not a pull request.** Splitting the pile out is a FORMAT change on a
blob every platform reads: a second file or a v3 frame whose reader must ship before any writer
(unknown versions are refused, `state_blob.rs`), a backup envelope that must carry both halves, and
the reload guards that read KeyPackage identity across the whole store (`key_package_keys`,
`recharger_mls_au_resume`) must agree on where a bundle lives. The cheaper alternative is to SHRINK
the pile - the unclaimed-but-handed-out bundles that only the 84-day expiry reclaims
([key-package-pool](protocols/key-package-pool.md)) - which needs the server's claimed-at column
that page already owes. **Options**: (a) shrink first, measure again; (b) a v3 frame with a
KeyPackage segment sealed separately and cached; (c) per-group storage, the structural lever the
[performance audit](frontend/performance-audit-2026-10-12.md) names third. Nothing is built.

**IS IT SAFE? ANSWERED YES, 2026-10-14, BY TWO ASSERTIONS** (`mls-core/tests/key_packages_are_separable.rs`).

1. **A joined group needs no `KeyPackage` row.** openmls 0.9 `StagedWelcome::into_group` copies the
   bundle's leaf key into the group's own `EpochKeyPairs`. Every bundle can be deleted and the state
   reloaded, and the joined group still applies a commit whose path is encrypted to that leaf, then
   sends and receives. This holds even for a last-resort package, whose row `into_group` keeps. Every
   bundle lives in one row under the `KeyPackage` label, so a split by label is exact.
2. **A bundle missing when its Welcome arrives costs that join and nothing else.** The Welcome
   cannot be opened, and the device's other groups are untouched. The device recovers by the
   existing rejoin path.

**What this fixes in a two-file design.** These two facts set the write order:

- Mint: the bundle segment must be durable BEFORE the package is published.
- Consume or prune: the core blob is written first and the segment after.

A crash between the two steps costs one of these, never a group:

- **Before the segment is written:** a bundle reappears. That loses forward secrecy on one init key
  until the 84-day prune; the server never hands the bundle out again.
- **A mint lost before publication:** nothing.

**Measured 2026-10-14** (`heavy_state_checkpoint.rs` `key_package_share_of_a_checkpoint`, OXYGEN,
release): 80 groups are 7.70 MB and 11.1-11.6 ms; adding 2535 bundles makes 12.53 MB and
15.6-16.1 ms. **The pile is 39 % of the bytes and ~28 % of the encode-and-seal time.** That is the
ceiling of a split, and it is CPU on a desktop. What a phone checkpoint spends on writing to disk and
on IPC, against encoding, is still not measured. The Mi 9T's 1.4-2.0 s checkpoints after a sign-in
are far above anything encoding 15 MB costs here.

**Recommendation (for the user's go).** Do not build the split yet. Settle the phone first with the
trace the [performance audit](frontend/performance-audit-2026-10-12.md) already owes, which splits
the export from the write:

- **If the write dominates:** build option (b) as ONE file holding a cached, separately sealed
  bundle segment. It saves the encode and the seal and keeps today's single atomic write, so none
  of the crash orderings above are needed. Two files only if the bytes on disk themselves are the
  cost.
- **If the export dominates:** the same single-file variant is the whole fix.
- **Either way, the reader ships first and the floor must reach it before any writer.** This is the
  [state blob framing](protocols/mls-protocol.md#the-state-blobs-framing---read-first-write-later) rule.

The after-sign-in storm is about the NUMBER of checkpoints (finding 2 of the
[community-open page](frontend/community-open-slowness-mi9t-2026-10-13.md)), and a split does not
change that number.

### DECISION OWED - the ceiling's `postgres` arm names a test this estate's own upgrade path can never satisfy

**Found by performing the thing the gate asks for, on 2026-09-15, and discovering the gate cannot
accept it.** This is not a defect in either file: both are internally consistent and each was written
carefully. They have simply drifted apart, and only a decision separates them.

**The standing rule that makes this a question at all** (user, 2026-08-31): *"Je prefere blinder de
test et faire les choses automatiquement qu'avoir une review humaine qui n'arrive jamais"*, for *"un
projet qui peut 'vivre tout seul'"*. So a refusal is never a routing decision to a human queue - it
is a statement that a gate is MISSING, and it must NAME the test that would lift it. **A queue
nobody drains is worse than the merge it prevented.**

**What each file says, and neither is wrong.** `.github/scripts/lib/ceiling.sh` refuses a `postgres`
major bump and names its escape: a test that starts the NEW major against a data directory written
by the OLD one. `infrastructure/dev/version-gap.yml` is where that test's result gets declared, and
its taxonomy admits exactly one value that lifts a refusal - `in_place_upgrade`, *"the new major
serves production's OWN data directory, carried across by the documented upgrade path"*. A
`logical_restore` - `pg_dump` and restore into a cluster the new major built itself - *"lifts
NOTHING"*, and that judgement was itself a correction made while writing the file, to stop a green
gate that proved nothing from re-arming the 2026-09-01 outage.

**And the estate has since decided not to build the path the lifting value describes.** On
2026-09-01, `auth_db` being small settled it: dump and restore, not `pg_upgrade`, *"which requires
both binaries live in one image"* and *"should not be built"*. The 2026-09-15 rehearsal executed
that decision end to end against production's own bytes and it is completely successful
([databases](infrastructure/databases.md#crossing-a-major-version---the-rehearsed-procedure)) - and
it is a `logical_restore`. **So the ceiling's refusal can never be lifted by any work this estate
intends to do**, and the `postgres` row stays `evidence: none` for ever.

**The question is what the refusal should NAME, and there are two honest answers.**

1. **A datastore major is an OPERATION, not a dependency update, and the arm should say so.** No
   test can make "Dependabot bumps postgres and it auto-merges into a deploy" safe, because the
   safety lives in a dump taken minutes earlier by an operator, not in the diff. On this reading the
   refusal is permanent and correct, and what it should name is not a test but a CONDITION: the
   cutover has been performed and the pin moved by hand. That is a queue of one, drained by the
   person who did the migration, which is not the unmanned queue the rule is aimed at.
2. **Or `version-gap.yml` gains a fourth value.** Something like `rehearsed_cutover`: the documented
   upgrade path for THIS estate, executed against production's own data, with the mount layout the
   new image expects and the application serving on the result - all of which is now true and
   evidenced. That keeps the gate's shape (a refusal naming a checkable thing) at the cost of
   admitting a value whose proof is a dated note rather than a CI run, which is exactly what the
   file's `proof` field already contemplates.

**What must NOT happen is the third thing**: quietly relaxing the `logical_restore` line to lift the
refusal. That line is the correction that stopped a gate which would have gone green on the very
upgrade that took production down, and re-opening it would re-arm precisely that.

**Nothing is blocked on this.** The cutover is authorized and rehearsed and proceeds either way; the
ceiling refusing a `postgres` bump in the meantime is the outcome both readings want.

---

### QUESTION - does an iOS attachment CONSUME the avatar cache file it is handed?

Found 2026-08-17 while writing the initials fallback, and it is a question rather than a defect
because settling it needs an iPhone. `CanariShowLocalNotification` hands `attachmentPath` straight to
`UNNotificationAttachment`, and for an avatar that path IS the durable cache file `avatar_<id>.jpg`
that `CanariFetchAvatar` writes and later re-reads. The NSE does the opposite on purpose: its
`attachImage` copies to a temp file first, carrying the comment *"an attachment URL is
consumed/moved by the OS, so we never hand it a shared cache file directly"*.

Both cannot be right. If the OS really moves the file, the app-process cache is emptied by its own
first hit and every subsequent notification re-fetches - a silent, permanent cache miss that no log
would name, since a re-fetch looks exactly like a first fetch. **What settles it is one device
observation**: notify twice for the same person with the app alive, then look for `avatar_<id>.jpg`
in the app container. If it is gone, the app path copies too, exactly as the extension does. The
initials disc is unaffected either way - it writes to `NSTemporaryDirectory()` on both.


### Is a MiGallery application worth it?

An open question, deliberately. The Canari formula (SvelteKit + Tauri) transfers, so the cost is
knowable - but MiGallery's value is a gallery that a browser already renders well, and the question
is what an app would add that the web version cannot do. Answer that before estimating anything.

**STILL OPEN, AND NOW WITH A DELIVERABLE ATTACHED (user, 2026-09-10).** Asked directly, the user
answered neither yes nor no: *"Dis-moi d'abord ce que ca coute."* So what is owed is a costed
scoping note - scope, dependencies, and **what it adds to the surface that has to be maintained**,
which is the half that actually decides it. The paragraph above still governs the note's first
section: it must answer what an app adds that the web cannot do before it estimates anything.
Nothing is built until the note is read.

---


### Server - can occupancy be monitored, and will it hold?

**The media half shipped 2026-08-18** and is documented on
[storage-forecast](infrastructure/storage-forecast.md): `/admin/storage` now separates growth (bytes
written per 7-day window) from a retention sweep that has stopped taking anything, and counts
separately the objects no sweep can EVER reach. That last one was not hypothetical -
`purgeExpiredMedia` iterates the metadata index, so an object with no entry is invisible to it for
ever, and 7 such objects (~11 MB) were already measured.

**The MLS half shipped 2026-08-19**, and this entry is closed. Postgres and Redis are no longer bare
totals: the panel lists the eight MLS tables by size with their row counts, reports the queue as four
figures (total, devices, oldest, and the DEEPEST single device queue - the one a total cannot show),
counts §5.7's WP-GHOST-1 shape continuously, and breaks Redis down by key prefix from a bounded
sample that says how much it sampled. The production baseline and the reasoning are on
[storage-forecast](infrastructure/storage-forecast.md); do not restate them here.

**Decided 2026-08-17: the panel is the whole of it, there is NO alert.** The user's call. Worth
stating what that costs rather than pretending it costs nothing - the standing rule is that a correct
mechanism with no report is found by hand a day late, and a panel is a report only for whoever opens
it. The slope is what makes it survivable: a number read once a month against a trend is enough to see
a wall coming, where a bare total is not. **§5.7's own "more than a few hundred rows" predicate is
deliberately left unarmed**: the deepest real queue is 189, so a threshold set from the last incident
would be a threshold nobody has measured against the population it would run on.

> **Already shipped, do not re-open:** _"ne garder que les messages les plus recents (dernier mois),
> et le reste recuperable en demandant l'historique a un appareil mobile"_ is exactly the device
> window plus the scrollback range request delivered in the history-reconciliation rework - web keeps
> 90 days, mobile and desktop 5 years CLAIMED (the local garbage collector prunes at 90 days everywhere today - [backlog](backlog.md)), and reaching the top of the scrollback asks a peer for the
> range below the window. See [history-reconciliation](protocols/history-reconciliation.md) and
> `historyWindow.ts`.

> **Already shipped, do not re-open:** _"pourquoi garder plus d'un accuse de lecture sur de vieux
> messages ? Si le dernier message a ete lu, le precedent aussi"_ is the read watermark that replaced
> per-message `readBy` in the same rework - read state is now ONE timestamp per (conversation, user),
> and `readersOf` derives the per-message display from it.

---


### QUESTION - iOS has the mention elevation on ONE path too, and the plugin cannot express it

NOTIF-16 fixed the Android half on 2026-09-08: a message naming the reader is filed on
`canari_mentions`, and it is now chosen by BOTH builders rather than only the push one
([story](../../CHANGELOG.md), [rule](durable-rules.md)). The obvious follow-up - "does iOS need the
same?" - is ANSWERED in the source, and the answer is half of one and half of the other.

**iOS has no notification channels, and it does not need them: it has the elevation already, on the
push path.** `canari_NSE/NotificationService.swift` scans the decrypted text for `@[uuid]` exactly as
the Kotlin service does and sets `content.interruptionLevel = .timeSensitive` for a mention, which is
what breaks through Focus. That half is done and is not owed anything.

**The other half cannot be fixed the way Android's was.** The WebSocket path on iOS is the same
`tauri-plugin-notification` call, and its `Options` type declares `channelId` and NO
`interruptionLevel` - so there is no argument to pass. The Android fix worked because the plugin
happened to expose the field that mattered there; here the field does not exist. Closing it means
patching the plugin, adding a native command beside it, or accepting that a mention delivered over
the socket on iOS arrives at the default level.

**So the QUESTION is which of those three, and it is a judgement, not a measurement.** What each path
requests is readable in the source, above; what a locked iPhone does with it is not, and that part
waits on hardware like everything else iOS. Do not "fix" this by marking every message
`.timeSensitive` - that is the always-true mutation the Android tests exist to forbid, wearing an
Apple badge, and Apple reviews it.

### DECISION OWED - naming the author of each line inside a salon's stacked notification

Asked for by the user on 2026-08-20: salon notifications should read like a DM's - successive
messages stacking one under another in a single banner. **The stacking already exists**;
`handleChannelMessage` goes through `showNotification`, so a salon gets the stable per-conversation
id, the `MessagingStyle` history rebuild, the badge, the clear-on-open sweep and the cross-device
dismissal. NOTIF-11 is what will say so on a current APK.

What is genuinely missing is the ATTRIBUTION. `senderName = title` and `groupName = ""`, so every
line in a salon's stack is attributed to `<Communaute> - #<salon>` and a reader cannot tell who said
what. The comment there is honest about why: the server sends only `senderId`, for the avatar.

Two shapes, and the choice is the user's:

1. **The name on the wire.** One field beside `channelName` and `workspaceName`, which already
   travel in cleartext. Cheapest, and it puts one more piece of who-talks-to-whom through Google and
   Apple - which is the exact cost the reaction push was rewritten in 2026 to stop paying.
2. **A `push/display-name/:userId` lookup, beside `push/avatar/:userId`.** The phone already
   authenticates to that route with the push secret and caches the answer for 24 h; a name would
   ride the same shape and put NOTHING new through a third party. Costs one request per unknown
   sender on a cold notification, cached thereafter.

**Recommended: (2)**, because the avatar proved the shape and it keeps the wire where it was. Not
started - it is a real work package, and NOTIF-12 records the current behaviour rather than failing
on it, so nothing here blocks the campaign.

### QUESTION - a reconciler's SILENCE means both "we agree" and "nobody answered", and only one of them is safe to escalate on

Split out of the responder P1 on 2026-09-08, when that entry closed on its measurement. **The defect
is fixed and measured; what is left is a design choice nobody has made**, which is why it belongs
here rather than in [backlog](backlog.md).

`escalateReconciliation` rotates to another member when a device can PROVE it is incomplete - it
holds a frame it can never read. That proof is what gates the escalation, and the gate exists
because the observation it would otherwise act on is ambiguous: a responder that stays quiet because
it holds the same history and a responder that is frozen produce **the identical silence**. A device
with no local proof of a gap cannot tell them apart, so it cannot escalate on silence alone.

**The obvious answer costs the saving the mechanism was built for.** Making the agreeing responder
ACK would disambiguate it immediately - one frame per group per ask - and that is exactly the traffic
the state-key comparison exists to avoid. So the question is a trade, not an oversight:

- is one ack per group per ask affordable at the population's real ask rate, measured rather than
  assumed?
- or is there a cheaper discriminator - the server already knows whether it forwarded to anybody
  (`no_peer_online`, `excludedOnline`), and that is a fact about REACHABILITY the asker currently
  never sees?

**Nothing should be written until one of those is measured.** The second looks cheaper and needs no
new frame, but it answers a different question - "was anyone reachable" is not "did the reachable one
agree" - and conflating them is the shape this repository keeps paying for.

**ONE HALF OF THE TRADE IS NOW MEASURED, 2026-09-08, AND A THIRD OPTION APPEARED WITH IT.** The
saving is not free: HEAL-repair heals three times in ten, and the arithmetic is the election's - three
online members, one of which holds the messages, twenty requests routed 10 / 7 / 3 across them
([backlog](backlog.md)). So the question is no longer *is one ack per group per ask affordable*; it
is *is it more expensive than seven failed repairs in ten*.

And the third option needs no new frame at all. The asker in that measurement DID hold local proof of
its own incompleteness - frames it has and cannot read, the same proof `escalateReconciliation` is
gated on - and the walk stopped anyway, because a responder that agrees on the state key answers with
its COVERAGE, and adequate coverage is signalled by silence. So the termination is not being taken on
an ambiguous silence at all: it is taken on a well-formed answer whose meaning, *I cover what you
asked*, is being read as *and therefore you are complete*. Refusing to terminate while the local proof
stands costs nothing and adds no traffic. Whether it is sufficient - whether the walk then reaches the
holder rather than merely re-asking the same agreeing peers - is the part still owed a measurement.

### QUESTION - why did the user's PC join Mineurchestre's key group twice on 2026-09-25?

**Raised 2026-09-29, when the defect it caused was closed.** Rejoining a key group with the same key pair removes the device's own first leaf. That is how the PC's salon went blank ([channel-encryption §22.2](protocols/channel-encryption.md#222-a-key-group-held-with-its-own-leaf-removed-is-not-held---fixed-2026-09-29)). Since `v0.18.30`, a device in that state re-joins as soon as it loads, so the consequence is repaired. The cause of the double join is not. The candidates are the "externalJoin FAILED to checkpoint - a reload before the next write would rejoin" warning, or two tabs joining before the leader lock settled. **What would settle it**: a second commit from one device on one key group within minutes, read from `mls_commit_log` (`senderDeviceId`, `baseEpoch`, `createdAt`), together with that device's console from the same load.

### DECISION OWED - `user_dismissed_group` grows one row per manual delete, for ever

**Raised 2026-08-27** (876 rows for one account, put there by the campaign). Nothing reads it in bulk, so it is no incident, but it is an unbounded table nobody has decided about. A row may only go once no device of that user can still hold the group: the group's own purge (`cleanupSoftDeletedGroups`) is the natural moment, and whether it should take the dismissals with it is the decision.

### Is a Remove meant to be durable against a later re-add?

**DECIDED by the user, 2026-10-14: YES, for private group conversations.** A re-added member keeps
what preceded their removal and NEVER receives what was sent while they were out (user,
2026-10-14). Built as an entitlement filter on the ANSWERING side, keyed on membership intervals the
server records (migration `030`) - design, clock and what it does not cover in
[history-reconciliation](protocols/history-reconciliation.md#a-remove-holds-against-a-later-re-add---the-answering-peer-withholds-the-window-decided-by-the-user-2026-10-14).
Communities keep their own decision (a returner may read the past); 1:1 conversations have no remove
path. What follows is the question as it was raised, kept for its reasoning.

**Raised 2026-08-26 by GRP-8**, and it is a decision rather than a defect - which is why the P2 it sits
behind ([backlog](backlog.md)) is written to change nothing until this is answered.

**What the code does today.** `sendHistoryBundleForIds` clips only on `since`, a time window the ASKER
declares (`groupActions.ts`), and performs no entitlement check of any kind: it never asks whether the
requester was a member when a message was sent. So a device removed at epoch 3 and re-added at epoch 4
that asks for the ids it is missing would be SERVED the plaintext of the messages sent while it was out,
re-encrypted under the current epoch.

**Why that is not self-evidently a bug.** `sendFullHistoryBundle` hands a NEWLY INVITED member the
group's whole backlog on purpose, so *"a member gets the history"* is the stated policy, and a re-joining
member is a member. GRP-3's assertion is about live delivery WHILE removed, and it holds - it says
nothing about a later re-add.

**Why it is not self-evidently fine either.** If a Remove is meant to be durable, then re-adding a member
is a way to hand them everything the Remove was supposed to withhold, and any admin who can re-add can
therefore un-do a removal retroactively. That is a property worth stating deliberately in either
direction rather than inheriting from whichever code path was written first.

**What was actually observed, and what it does not prove.** In the GRP-8 run the exchange went the OTHER
way: the re-admitted device SERVED two messages to the peer and received none. That is a fact about one
run, not a property - the direction was decided by which device noticed a digest difference first.

**What answering it costs.** Nothing to measure; it is a product decision. If a Remove must be durable,
the fix is an entitlement filter on the SENDING side keyed on the requester's membership history, which
the server can answer - not a client-side change, because a client asking politely is not a control. If it
must not be, the P2 behind this shrinks to what it already claims: stop calling the exclusion window a
loss, and stop reconciling for it.

## Which account a SECOND phone would carry, the day one is attached again

**Parked because the hardware is gone, not because the question is hard.** A Pixel 6a was plugged in
temporarily on 2026-09-04; `adb devices` has listed only the Mi 9T (A1) since, which is what
`state.mjs` reports as `A2 (9335) UNREACHABLE` - **that line is explained and is not a defect, so no
session should spend time chasing the forward.**

The question it leaves: A2 is bound and addressable on port 9335, and **no account is assigned**. The
peer's, or a third one? One line in the out-of-tree `names.mjs` decides it, and guessing is an
identity invented by a tool rather than chosen by the person who owns the accounts.

**It is worth answering BEFORE the hardware returns**, because it now overlaps something concrete:
the third test account owed for first contact (NOTIF-17) would also be the obvious occupant of A2, so
the two asks are one decision rather than two. See the table of what is owed to the user in
[backlog](backlog.md).

**Where it came from.** Item C1 of the harness tidy, which is otherwise complete and was deleted on
2026-09-08 - its A and B sections shipped, its D items are the campaign order that
[cross-client-campaign-resume](cross-client-campaign-resume.md) carries, and its E items are the
standing bar now in `CLAUDE.md`. This was the only thing on the page that was neither done nor a
duplicate.

## Whether the three legal documents should be localized at all

**Parked because it is a legal question wearing a coding rule's clothes.** This repo's standing rule
is that every user-visible string goes through Paraglide, and the terms of use, the privacy policy
and the child-safety standards are **~900 lines of hardcoded French** - by far the largest violation
of it in the app. Their shell was rebuilt on 2026-09-10 and its chrome IS localized
(`legal_eyebrow`, `legal_last_updated`, the titles, the table-of-contents heading); the bodies were
deliberately left as they are, and not for effort.

**The reason is that a translated contract is a DIFFERENT CONTRACT.** These three texts name a French
association, a French address, the CNIL, article 33 of the RGPD and the courts of Saint-Etienne.
Which language version governs is a thing a lawyer decides, not a translator - and shipping an
English rendering through Paraglide would silently create a second document that a reader could
reasonably rely on. Google Play and the App Store both take the URL rather than the text, so nothing
in the store pipeline forces the question either.

**So the question is for the USER, and it has three possible answers**: leave them French-only and
carve them out of the Paraglide rule explicitly; translate them and state in the documents
themselves which version governs; or serve an English *summary* that says plainly it is not the
binding text. Only the first costs nothing.

**What must NOT happen is a session "fixing the lint" by machine-translating them.** That is the
failure mode this entry exists to prevent.

## Should a device that dropped a frame say so?

Parked 2026-10-09 when the "twelve of sixteen messages fetched and dropped" entry was closed as a defect
([campaign-measured-defects](protocols/campaign-measured-defects.md#twelve-of-sixteen-messages-fetched-and-dropped-the-hole-at-epoch-121-prod-2026-09-02)).
Every cause that dropped frames silently is fixed, and the loss that remains is reported where it can be
acted on (the hourly commit-log hole report on the server, the shortfall report on a partial restore on the
client). The question is whether the USER should ever see that a frame was dropped on their device: the
"SECURISE & SYNC" shield that did so lied, and was removed by the user's choice to stop exposing the
machinery. **Nothing is blocked on it**, and it is a product decision, not a measurement.
