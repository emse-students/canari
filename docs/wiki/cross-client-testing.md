# Cross-client test campaign

The state of the manual-but-automated campaign that exercises Canari across **three simultaneous
clients** - two desktop browsers and an Android device - against production.

**This page is a dashboard and nothing else.** It says which checks exist, what each one asks, and
where each one stands. It deliberately does not carry diagnoses: a defect's story belongs in
`CHANGELOG.md`, and the rule it taught belongs on the wiki page for the module it lives in.

| Where | What it holds |
| --- | --- |
| this page | every check, its category, its state |
| [testing-methodology](testing-methodology.md) | how a result earns the right to be believed - the 31 harness faults distilled |
| [`tools/cross-client-harness/`](../../tools/cross-client-harness/) | the instrument: what it drives, how to operate it, the files |
| `CHANGELOG.md` | the narrative of every defect this campaign shipped |
| `CLAUDE.md` | open Work Packages, and the durable rule each defect taught |

Sibling of [device-verification](device-verification.md), which answers a different question: that
page asks whether a native path works **on hardware at all** (one device, one check); this one asks
whether the system stays correct when **several clients, several lifecycles and a damaged store**
meet.

> **Target is PRODUCTION** (`https://canari-emse.fr`). Real accounts, real messages, real FCM. There
> is no staging that carries push.
>
> **The working rig is `../canari-harness`**, a sibling of this repository and deliberately not a
> scratchpad (which is scoped to one session). `chrome-w1` and `chrome-w2` inside it ARE the W1 and
> W2 devices - their MLS identity, their history, their login. Verified across the move of
> 2026-08-11 by fingerprinting both profiles before and after: same device id, same MLS blob size to
> the byte, same conversation and message counts.
>
> **Credentials live in `../canari-harness/test-accounts.json` and never in this repository**, which
> is public. The two accounts appear here only as **owner** (W1, A1) and **peer** (W2). No PIN, login,
> display name, device id or group id belongs on this page.
>
> **Every test message goes in the owner-peer DM, and nowhere else.** A one-off probe once fired a
> "dangerous link" warning into a real colleague's thread. Anything needing a CHANNEL uses the
> `Campagne de test` community - never MiTV, whose private channels are readable by every
> association admin.

---

## State vocabulary

| State | Meaning |
| --- | --- |
| `pending` | never run |
| `passed` | ran, assertions held, run was clean |
| `failed` | ran and did not hold - always paired with a Work Package or a fixed commit |
| `to-revalidate` | passed once, but a later commit touched what it measures, or a release shipped since |
| `deferred` | deliberately not run yet, with a reason (a decision owed, the user needed, an ordering constraint) |

A `passed` check drops to `to-revalidate` when a commit touches its area or on a release. **The
whole campaign is `to-revalidate` as of 2026-08-10**: the repair mechanism every phase after MSG
observes was deleted and rebuilt, so every earlier HEAL observation was made against a code path
that no longer exists.

**Every state below is therefore a HISTORY, not a plan.** The roadmap is clear and no Work Package
is open, so the decision taken on 2026-08-11 is to re-run the campaign in full, to the end, fixing
what comes up as it comes up - see [the run plan](#the-run-plan-for-the-full-re-run). What each row
still says is what that check has cost and taught, which is why it is worth reading before running
it again; it is not a claim that the check need not run.

---

## Where the campaign stands

**The phases below the rule were added 2026-08-11**, when the campaign stopped being a list of
things that had once broken and became [a matrix of the feature
surface](#the-matrix-and-why-the-phases-above-were-not-one). They are not a backlog of suspicions:
they are the cells that were empty. The very first question asked of one of them found a defect
sitting in production.

| Phase | State | What is left |
| --- | --- | --- |
| **0** - setup | `passed` | SETUP-3 restarts each session |
| **MSG** - messages | `to-revalidate` | 10/10 passed |
| **FWD** - forwarding | `to-revalidate` | 5/5 run; 3 failed and shipped fixes |
| **TAB** - tabs and windows | `to-revalidate` | TAB-1 and TAB-7 never run |
| **LIFE** - Android lifecycle | `to-revalidate` | 8/8 passed |
| **NOTIF** - notifications | `pending` (4/10 run) | NOTIF-2, 3, 5, 6 |
| **HEAL** - does a broken group repair itself on the browser? | `pending` | all four owed against the current mechanism |
| **PIN** | `pending` | PIN-1..10 |
| **MULTI** - one user, two devices | `pending` | MULTI-1..6 |
| **CORRUPT** - deliberate store damage | `deferred` | runs last: it destroys state |
| --- | --- | --- |
| **MUT** - edit, delete, react, pin | `pending` | MUT-1..20. Every row runs TWICE: MLS in a DM, REST in a channel |
| **READ** - receipts and unread counts | `pending` | READ-1..10 |
| **TYPE** - typing indicators | `pending` | TYPE-1..5 |
| **SEARCH** - finding a message | `pending` | SEARCH-1..6 |
| **MENTION** - @ and what it triggers | `pending` | MENTION-1..6 |
| **CALL** - audio and video | `pending` | CALL-1..20. **The largest hole**: no harness script exists, and CALL-13 (iOS CallKit) has never run on hardware |
| **COMM** - communities, channels, roles | `pending` | COMM-1..22 |
| **GRP** - group membership and invitations | `pending` (3/9 run) | GRP-2 `failed` and is fixed and re-verified; GRP-1 passed; GRP-3 (traffic reconciles both ways) passed; GRP-4..9 owed |
| **DEL** - deleting a conversation, crossed | `pending` (1/10 run) | DEL-1 `passed` armed, after four vacuous runs; DEL-2..10 owed |

The reconciliation that backs every phase above was **rebuilt on 2026-08-11** and no longer reads
the screen - see [what recon.mjs measures](#recon-measures-the-store-not-the-screen). The rebuild
paid for itself within the hour: the first clean run's *logcat* held
[WP-PUSHHERD-1](#wp-pushherd-1-the-push-decrypt-herd-that-got-the-app-killed).

---

## Phase 0 - setup

Nothing here is a test. It is the harness, and a harness that is not proven produces failures that
belong to itself.

| Id | Step | State |
| --- | --- | --- |
| SETUP-1 | Build the debug APK, plus the jniLibs `.so` rescue (`test_adb.py` `_ensure_native_lib_present` - a Windows symlink failure builds an APK with no native lib) | `passed` |
| SETUP-2 | Clean uninstall + install. **Wipes `mls.bin`** - the device loses its MLS identity and local history, by design | `passed` |
| SETUP-3 | Start logcat with the 19-tag whitelist from `test_adb.py`. A tag missing there is a verdict that never arrives | re-run each session |
| SETUP-4 | W1: log in as **owner**, enrol the device, set the PIN. **The one manual step: the 2FA code** | `passed` |
| SETUP-5 | W2: log in as **peer** (no 2FA on that account), set the PIN | `passed` |
| SETUP-6 | A1: log in as **owner**. **Decline biometrics** so the PIN is always the unlock path - a fingerprint prompt is the one thing no tool here can answer | `passed` |
| SETUP-7 | **Discovery pass.** Enumerate the real at-rest artefacts rather than guessing them (see below) | `passed` |
| SETUP-8 | Baseline snapshot of the intact Android app data, so every corruption test can roll back without a re-enrolment | `passed` |
| SETUP-9 | The dedicated venue for channel traffic | `passed`, as a **community** rather than a channel |

**SETUP-9 became a community, not a private channel**, and the reason is a finding: a private
channel in an existing association is readable by every admin of that association, so it is not a
private venue at all. The `Campagne de test` community holds only the two accounts.

**Decisions taken 2026-08-05, not to be re-litigated:** all channel traffic goes to that one venue;
the peer account has no 2FA (only the owner does, once, at SETUP-4); wiping the phone is authorised,
because the re-enrolment path and MULTI-3 are only testable from a clean device.

---

## MSG - messages

Baseline first. An exotic failure is only meaningful once the plain path is proven on the same
harness in the same session.

| Id | What it asks | State |
| --- | --- | --- |
| MSG-1 | W1 -> W2 plain DM: under 2 s, one copy, correct author | `to-revalidate` (also re-proved by 38 consecutive sends) |
| MSG-2 | W2 -> A1 with the app foreground: no duplicate against the push | `to-revalidate` |
| MSG-3 | Reply renders with its quoted parent on both sides | `to-revalidate` |
| MSG-4 | Image then PDF: ciphertext upload, both render, receiver actually decodes | `to-revalidate` |
| MSG-5 | Channel message converges on all three; **no `masterSecret` in any payload** | `to-revalidate` |
| MSG-6 | Link preview served through the proxy, never a third-party `<img src>` | `to-revalidate` - its log also carried a shipped bug (a 400 on `/api/mls/link-preview`) |
| MSG-7 | 30 rapid sends: order preserved, no gap, no duplicate | `to-revalidate` |
| MSG-8 | Send to a BACKGROUNDED tab | `to-revalidate` - **its first verdict was wrong**, see WP-HIDDEN-1 |
| MSG-8b | Same, receiver on another page: badge and unread count | `to-revalidate`, with a UX note - the tab TITLE never changes, so a backgrounded tab signals nothing until looked at |
| MSG-9 | Receiver offline (phone radios), then restored: lands once on reconnect | `to-revalidate` |
| MSG-10 | **Sender** offline: optimistic echo persists, outbox drains, survives a reload | `to-revalidate` |

MSG-9 must run on the phone: an offline RECEIVER cannot be faked in a browser
([methodology](testing-methodology.md#environment-traps-that-read-as-application-bugs)).

## FWD - forwarding

The phase that found the campaign's central defect.

| Id | What it asks | State |
| --- | --- | --- |
| FWD-1 | Channel -> DM forward, the exact shape of the reported prod loss | `to-revalidate` |
| FWD-2 | The same, 25 times in a loop - any single miss is the bug | `failed` -> WP-FWD-1 reproduced, then fixed |
| FWD-3 | Forward while the sender goes offline mid-send | `failed` -> same root cause |
| FWD-4 | Forward from A1, backgrounded 200 ms later | `to-revalidate` |
| FWD-5 | Forward into a conversation not opened this session | `failed` -> **root cause found**: the reload, not the forward |

## TAB - tabs and windows

| Id | What it asks | State |
| --- | --- | --- |
| TAB-1 | Backgrounded tab receives; title/badge updates | `pending` (largely subsumed by MSG-8/8b) |
| TAB-2 | Tab closed, message arrives, tab reopened: present exactly once | `to-revalidate` |
| TAB-3 | Whole browser killed and relaunched: all arrive, no re-login | `to-revalidate` |
| TAB-3b | Cold-start timing, five runs | `to-revalidate`, **with one unexplained run**: 77.7 s to render with everything ready at 6.9 s. Not reproduced in four further runs. If it recurs, capture everything between `Drain start` and the decrypt |
| TAB-4 | Two tabs of the SAME account: no double-send, no epoch fight | `failed` -> WP-HIDDEN-1 **and** WP-MULTITAB-1, both fixed and re-verified |
| TAB-5 | Reload fired under 100 ms after submit: sent once or clearly queued, never lost | `to-revalidate` |
| TAB-6 | Delete the refresh cookie, then act: clean re-login, not a silent empty list | `to-revalidate` |
| TAB-7 | Offline -> act -> online, tab never reloaded | `pending` |

## LIFE - Android lifecycle

| Id | What it asks | State |
| --- | --- | --- |
| LIFE-1 | Foreground baseline | `to-revalidate` |
| LIFE-2 | Background (`HOME`): notification carries the real decrypted text | `to-revalidate` |
| LIFE-3 | Killed - **swipe from recents, not `am force-stop`** | `to-revalidate`. Force-stop is worth running but answers a different question: Android's STOPPED state cancels every FCM broadcast until a manual launch |
| LIFE-4 | Doze (`dumpsys deviceidle force-idle`) | `to-revalidate` |
| LIFE-5 | After a reboot, app never opened - exercises `CanariBootReceiver` | `passed` 2026-08-11. Notification carried the PLAINTEXT, decrypted natively with no WebView, both quick actions wired. **Needs the user** (the unlock pattern; `wm dismiss-keyguard` cannot). Its observation half found WP-DIRECTBOOT-1 |
| LIFE-6 | Offline (both radios) | `to-revalidate` - failed twice on the way, producing WP-PENDING-1 and WP-PENDING-2 |
| LIFE-7 | Notification permission revoked mid-life | `to-revalidate` |
| LIFE-8 | Process death (`am kill`), keeping WorkManager state | `to-revalidate` |

Cross every LIFE state with: receive a DM, a channel message, a commit, a call. That matrix is the
point of the phase.

## NOTIF - notifications

| Id | What it asks | State |
| --- | --- | --- |
| NOTIF-1 | App killed, DM arrives: decrypted notification with real content | answered by LIFE-8 |
| NOTIF-2 | App killed, a **commit** pushed, then a message | `pending` - the epoch gap. Background decrypt applies no commit, so a generic fallback is CORRECT; what must hold is that opening the app recovers |
| NOTIF-3 | The same, message several epochs later | `pending` |
| NOTIF-4 | Read on W1 while A1 is killed: notification dismissed on A1 | `to-revalidate` - failed three times first (WP-NOTIF-1) |
| NOTIF-5 | Per-channel level muted on W1: A1 does not notify, message still arrives | `pending` |
| NOTIF-6 | Quick reply from the shade (= check K) | `pending` |
| NOTIF-7 | Tap -> deep link into the conversation, **backgrounded** | `to-revalidate` |
| NOTIF-7b | The same with the app **KILLED** | `failed` -> WP-DEEPLINK-1; re-run passed, and the re-run's log found WP-RELOAD-DL-1 |
| NOTIF-8 | Doze + message: delivered, or on wake - record which | answered by LIFE-4 |
| NOTIF-9 | Two devices of one user: exactly one notification surface behaves | `to-revalidate` |
| NOTIF-10 | Airplane mode 10 min, 5 messages, then reconnect | `to-revalidate` - **all five survive**; the SHADE does not show them all, which is an OS collapse, not a loss |

## HEAL - does a broken group repair itself on the browser?

Everything WP-PENDING-2 and WP-DRAIN-1 proved was proved **on the phone**. The fixes are shared
TypeScript, but "the same code" is an argument, not a measurement, and the two clients do not break
the same way: the web MLS state is IndexedDB rather than `mls.bin`, the recovery runs against a live
WebSocket instead of a cold reconnect, and only the browser has a second tab that can hold the
leader role while the broken one recovers.

The break is made by **restoring an older snapshot** of the web MLS database over the current one -
exactly the rewind this campaign chased, done deliberately. Take the snapshot first.

| Id | How the group is broken | State |
| --- | --- | --- |
| HEAL-W1 | Restore a snapshot from BEFORE a membership commit, then have the peer send | `pending` - epoch gap. A `healed` verdict after applying ZERO commits is the WP-PENDING-2 fault reappearing |
| HEAL-W2 | Restore from BEFORE the group was joined at all | `to-revalidate` 2026-08-11 - it has never reached the branch it names, and it found a different defect instead. See below |
| HEAL-W3 | Freeze one client while the peer advances its ratchet past 2 000 frames in one epoch | `pending` - generation gap. `TooDistantInTheFuture` must beat `GAP_QUEUED`, as it does on Android. The expensive one: a scripted volume run |
| HEAL-W4 | HEAL-W2 with a SECOND tab holding the leader role | `pending` - **no prior art on either client**. The WP-MULTITAB-1 seam meeting the recovery seam |
| HEAL-repair | Does the history diff repair a rewound sender end to end? | `passed` 2026-08-10: `HEALED 14/14`, `ids mode, 554 id(s)`, `narrow retransmission=false`, and the frame rate back to ~14 console lines per 60 s against the ~450 frames/min of the deleted mechanism |

Every run of a HEAL check needs, without exception: `bundle-id.mjs` **first** (both browsers reloaded
onto the current bundle); a record of **which device answered**, since the responder is elected at
random; and a teardown that restores the **invariant**, never a snapshot.

### HEAL-W2: what four runs actually established (2026-08-11)

The break has to be CONSTRUCTED, and that is the check's whole design: the web MLS state is one
opaque blob (`mls_autosave`, ~1.9 MB) holding every group, so no edit makes a single group unknown -
a restore rewinds everything or nothing. So the group is created AFTER the snapshot (`newgroup.mjs`
+ `invite.mjs`, the only cheap deterministic epoch generator), proved to deliver, and only then is
the blob restored. `mlsdb.mjs` keeps the snapshot in its own IndexedDB database rather than a
`window` property, which is what lets the device under test navigate and reload between the two -
the earlier tab-lifetime version forced W1 to sit on a minutes-old page, where a sidebar row would
not open however often it was clicked.

**The branch it names was never reached, and the reason is the app being right.** Boot catch-up
(`[CATCHUP] batch history: N group(s) in 1 request`) re-joins the group from a Welcome still
available server-side before any frame can arrive, so by the time one does the group is known.
`handleUnknownGroup` is reachable only when no Welcome is available, which this construction cannot
arrange. Sending DURING the boot was tried and does not settle it either: it is a race, and a check
whose verdict depends on winning one measures the race, not the branch.

**What the fourth run found instead is a real defect, now fixed** (`1e8208d6`). Once catch-up had
re-joined, the re-joined group held no past-epoch secrets, and the peer's message - encrypted one
epoch earlier - hit the `msg_epoch < group_epoch` branch of `process_incoming_on_group`, which
answered `Ok(None)`, i.e. "no application payload". That is what a commit echo also answers, so the
message was ACKed off the server and dropped with no `LOST frame`, no marker and no solicitation.
Reasoning and the fix are in
[mls-protocol > a frame from a PAST epoch is two events](protocols/mls-protocol.md).

**So the re-run has a new expected outcome**, and it is a better check than the original: after the
deploy, the same construction must end with the message RECOVERED through `LOST frame` ->
`unreadable-frames` -> the history diff, and `unknownGroupFired=0` is then a fact about catch-up
rather than a failure. `heal-w2.mjs`'s verdict has to be rewritten around that before the re-run -
it currently reads `unknown.length` as a PASS condition, which no run can satisfy.

## PIN

Read [auth](frontend/modules/auth.md) before running any of these - the PIN, the device key vault and
`mls.bin` are one mechanism.

| Id | What it asks | State |
| --- | --- | --- |
| PIN-1 | Correct PIN, online | `pending` |
| PIN-2 | Wrong PIN xN: rejected, no lockout a correct PIN cannot clear, `mls.bin` untouched | `pending` |
| PIN-3 | A short PIN at setup, change, recovery AND unlock - the same rule in all four | `pending` - the documented lockout trap |
| PIN-4 | Change the PIN on W1: key re-wrapped, other clients unaffected | `pending` |
| PIN-5 | Change it on A1 while W1 is open | `pending` |
| PIN-6 | Remove the PIN: the at-rest key survives the transition | `pending` |
| PIN-7 | PIN unlock while OFFLINE | `pending` - **a clean refusal is the expected result**. Offline unlock is biometrics/vault only; widening it to the PIN is a security change wearing a UX hat |
| PIN-8 | Server unreachable but `navigator.onLine === true` (captive-portal shape) | `pending` - a transport failure must NOT log the user out; only a 401/403 may |
| PIN-9 | "Stay signed in", browser closed and reopened: vault path, no server round trip | `pending` |
| PIN-10 | Correct PIN, corrupt vault blob | `pending` - explicit failure, never a silent wrong-key state |

## MULTI - one user, two devices

| Id | What it asks | State |
| --- | --- | --- |
| MULTI-1 | Send from W1: appears on A1 as an OWN message | `pending` |
| MULTI-2 | Read on A1: read state reflected on W1 | `pending` - known backlog item, record actual behaviour |
| MULTI-3 | A1 enrolled AFTER W1 has history | `pending` - record exactly what arrives |
| MULTI-4 | Revoke A1 from W1, then A1 acts (= check L) | `pending` |
| MULTI-5 | W1 + A1 + a second W1 tab on one channel | `pending` - no epoch conflict, no `SecretReuse` |
| MULTI-6 | A1 offline a long while, 20 messages, then returns | `pending` |

## DEL - deleting a conversation, crossed with everything else

Added 2026-08-11, on the user's instruction: *"j'ai dit que je voulais tous les tests possibles,
qu'ils soient plus ou moins absurdes, plus ou moins courant. Un test absurde qui provoque une
incoherence peut servir dans d'autres contextes que celui de ce test absurde"*.

The phase exists because deletion had never been a subject, only a step - every phase deletes groups
as setup or teardown, and nothing ever asked what deletion CROSSES. The first question anyone asked
of it found WP-HISTGHOST-1 sitting in production, so the absurd-crossing argument is not a
hypothesis here, it is a measurement.

What makes a crossing worth a row: deletion is one of the few operations that removes state while
OTHER state keeps pointing at it. So each row pairs it with something mid-flight.

| Id | The crossing | What must hold |
| --- | --- | --- |
| DEL-1 | Peer deletes while a history solicitation for that group is outstanding | `failed` then fixed - see below. No banner survives on the removed row, no marker survives, and no solicitation is retried for it |
| DEL-2 | Peer deletes while a message from us is in the outbox | The outbox entry resolves or fails LOUDLY - never a silent, permanent pending |
| DEL-3 | Both peers delete the same conversation within a second of each other | No error surfaces on either side; neither resurrects it |
| DEL-4 | Delete a conversation while its media is still uploading | The upload stops or completes harmlessly; no orphan blob is left addressable |
| DEL-5 | Delete, then the peer sends into it anyway | The frame is dropped without a decrypt-failure marker - a deleted group must not look like a loss |
| DEL-6 | Delete while a drain is in flight for that group | `Drain start` still gets its `Drain complete`; the deletion may not deadlock the drain (WP-DRAIN-1's shape) |
| DEL-7 | Delete on W1 while A1 is killed, then wake A1 | A1 converges to deleted; it must not re-create the row from a queued frame |
| DEL-8 | Delete a group, then restore an MLS snapshot from BEFORE the deletion | The absurd one. The group returns to WASM while the server has none: it must be purged as an orphan, not left soliciting for ever |
| DEL-9 | Delete the conversation currently OPEN on screen | The view leaves cleanly; the composer cannot send into a removed row |
| DEL-10 | Delete while offline, then reconnect | The deletion reaches the server once, and does not re-broadcast on every later reconnect |

Every row is also a place to re-read the three states WP-HISTGHOST-1 was about - the durable marker,
the reactive phase, the scheduled burst - because they are exactly the kind of thing that is cleared
on one path and forgotten on the other nine.

### DEL-1, and what it cost to make it mean something (2026-08-11)

The rig is `del1.mjs`. It took four runs to produce one honest verdict, and each failure is a
methodology lesson rather than a product one.

1. **It invited itself.** The script took the first option in the member picker without checking it
   matched the query; the picker offers users who are ALREADY members, so it invited the account it
   was running as, the roster stayed at one, and it then waited a minute for a peer that had never
   been invited. On a rig whose directory holds real colleagues, the same blindness could have added
   one of them to a test group. Two name-parsing heuristics were tried to tell self from peer and
   both read the wrong substring off `innerText`; the fix was to stop parsing and believe only the
   roster going from one member to two. **That defect is now GRP-2, and it is fixed in the product.**
2. **It scoped a lookup by an id it never had.** The group id was read with a UUID matcher over
   `location.pathname`, copied from `heal-w2.mjs`. This app routes every conversation to a bare
   `/chat` and keeps the selection in a store, so that matcher returns null for every conversation,
   always. The id comes from the `conversations` store in IndexedDB now.
3. **It passed while measuring nothing.** The three messages were sent AFTER the invite, so the peer
   received them live, lacked nothing, and recorded no marker - there was nothing for the deletion to
   clear and the assertions would have held on a build with the fix reverted. The history now
   predates the join, and a run that finds no marker reports `VACUOUS`, never `PASS`.
4. **Armed, it FAILED - and the fix was one fifth of a fix.** `lifecycle: 'removed'` with the marker
   surviving at its ORIGINAL `since`: the delete had reached the peer and the marker had never been
   removed, rather than having been re-created. The path that ran was the `groupDeleted` system
   message, one of five places writing that state inline. Collapsed into `retireConversation`, now
   the single writer, guarded by a source grep in `conversations.retire.test.ts`.

The lifecycle field is what separated cause 4 from "the delete never arrived", which is a different
and much larger defect. **A check on a state that several paths can write must report which path
wrote it**, or its failure sends the reader to the wrong fix.

**The fifth run, against the deployed fix, is the one that counts:** marker present and
`lifecycle: active` before, marker gone / banner absent / `lifecycle: removed` after. `PASS`, armed.

The fixture the run needs - create a group, invite the peer, prove the roster moved - is now
`testgroup.mjs`, shared by `del1.mjs` and `grp2.mjs`. It keeps its own roster-based peer
identification even though GRP-2 is fixed: **a fixture must not depend on the fix it is used to
verify.**

### What the accessibility work bought the harness

`grp2.mjs` asserts that a list is EMPTY. Before the picker carried `role="listbox"` /
`role="option"`, the only way to reach it was to look for a portalled `<ul>` whose class matched
`fixed` - and "no element matched my class selector" is not the same statement as "the list offered
nothing". One is a verdict, the other is a selector that may simply have gone stale. The check now
reads `aria-expanded` and counts `[role=option]`, which are contracts rather than styling.

This is the general form of the user's standing instruction: the attribute a screen reader needs is
the attribute a harness can trust, and neither of them breaks when someone changes a class.

## recon.mjs measures the store, not the screen

Rewritten 2026-08-11. The reconciliation is the campaign's only instrument for the silent-loss
class, and until this it read campaign markers out of the rendered message pane. Every problem that
design had came from one fact: **the pane is a window onto the history, not the history.**

It had to scroll to see anything; scrolling pages 50 rows at a time; so it needed a time window to
stay honest, a coverage proof that the window had been reached, and about a minute per side. Run
against the test DM - 1804 messages - it read **60 of them** and printed `reconciled: true`. Three
separate faults were stacked in that one line:

1. Its marker pattern was a private copy of the one in `results.mjs` and had drifted, requiring
   eight base36 characters where the sequenced markers filling the DM have seven. It matched
   **nothing**, on either side.
2. It called an empty difference over an empty set a reconciliation. `trustworthy: false` was
   printed directly beside `reconciled: true`, and the eye reads the first field.
3. Its scroll loop assigned `scrollTop` without dispatching an event, so at the top it assigned 0
   to 0, fired nothing, and concluded it had reached the beginning of history after four steps.

The rewrite reads both clients' IndexedDB instead. Rows are ciphertext at rest (`iv` +
`cipherText`) but `id` and `conversationId` are plaintext, so the two stores can be compared
exactly without decrypting anything. **1804 = 1804, shared 1804, zero either side, in 0.58 s** -
against roughly two minutes for a bounded, windowed answer that covered 3% of the conversation.

What that costs: the id sets cannot say a message *decrypted*, only that both clients hold it.
That claim is exactly what the loss class is about; rendering and decryption are asserted per
check, by the marker each one sends. What it buys, beyond the speed, is the property the user asked
for in general terms - it works on a conversation of any size, because it never looks at a window.

Three consequences worth keeping:

- **Membership comes from the `conversations` store, not from the message rows.** Keyed off
  messages alone, a conversation a client is in but has received *nothing* for has no rows, so it
  looks like a conversation the client is not in - and a total loss, the worst case, would be the
  one case that reconciled silently.
- **A conversation `removed` on either side is expected to diverge**, and is reported apart rather
  than as a difference. That is what deleting it means.
- **`VACUOUS` is a third verdict, not a flag on a boolean**, and it exits non-zero.

### GRP-3, and an asymmetry that was not a loss

The first store-based run flagged a shared group holding 0 rows on the inviter and 1 on the
invitee. That is indistinguishable, from the outside, from the group's first message being lost -
so `grp-traffic.mjs` was written to settle it: send both ways, then compare. Both markers rendered
on both clients, and the inviter picked up the missing row when it first opened the group. A
membership event the receiver records at once and the sender acquires later is convergence at
different moments, not a loss.

The check's first version asserted on what each side *gained* and failed on that difference of one.
The assertion belongs on where the two sides **end**, which is what the loss class is about.

## WP-PUSHHERD-1: the push-decrypt herd that got the app killed

**P1, found 2026-08-11 in the logcat of a green check** - `grp-traffic.mjs` passed and `recon.mjs`
reconciled, and the run was still not clean. Which is the whole reason observation is part of a
verdict here rather than a debugging step.

Android gave every push its own thread (`runWithWakeLock` per `onMessageReceived`). That is fine
for one push and pathological for a backlog: each thread reaches for the single `MlsStateLock`,
waits its 5 s, and each that wins reads the whole 1.6 MB `mls.bin`. Counted over one storm behind
a backlog:

| | |
| --- | --- |
| lock timeouts | **97** (~485 thread-seconds spent purely waiting) |
| full 1.6 MB MLS state loads | 11 |
| "group-join race" retries | 60 |
| `local=false` verdicts | 20 |
| epoch queries that actually ran | **10** |

Two defects, and the second is why the first compounded.

**The herd.** Twenty-plus concurrent handlers, from a handful of messages. Android ended the
argument itself:

```
ActivityManager: Killing 22636:fr.emse.canari/u0a469 (adj 905):
  excessive cpu 10090 during 300076 dur=1263194 limit=2
```

A killed process delivers no notifications and drains no outbox. The cost of the herd is not the
CPU, it is the app going silent.

**A lock timeout answering a question about group membership.** `isGroupLocal` returned a plain
`Boolean`, and *every* way of failing to reach the state - lock not acquired, `mls.bin` unreadable,
device key missing, JNI absent - came back `false`, which its one caller reads as "the group is not
joined on this device". Hence twenty verdicts from ten answers: half were given by a timeout, about
the **main DM**, a conversation the device had been in for months. Each of those false verdicts
routed the message into the Welcome-race retry loop - three more attempts, each re-entering the
same contended lock, for a group that was never racing a Welcome. Contention produced retries,
which produced contention.

The docblock even asserted *"A join race can only happen when this returns false"*, which is
exactly backwards under load: it returns false precisely when it could not tell.

**The fix is one lane and one more enum value.** Everything that touches `mls.bin` now runs on a
single process-wide executor, so the work is done in the same order by one thread instead of being
fought over by twenty - serialising adds no delay, because the lock had already made the work
serial; it only removes the contention around it. And `GroupLocality` has three values, so
`UNKNOWN` reaches neither recovery: the catch-up answers an epoch gap and the race answers a
pending join, and nothing has diagnosed either. The push falls through to the WorkManager fallback,
where work with no deadline belongs.

The serialisation *dissolves* the second defect rather than patching it - with one lane, the FCM
side no longer contends with itself at all. The tri-state stays because `MlsBackgroundWorker` is
still a second contender, and because the conflation was wrong independently of the herd.

iOS carried the same conflation in `NotificationService.swift` (an unreadable `mls.bin` or an empty
device key both said "not local") and got the same tri-state. **It has never run a check on
hardware**, so that half is compile-verified only - which proves nothing about running, and is
recorded here as owed rather than done.

## The matrix, and why the phases above were not one

Added 2026-08-11 on the user's instruction: *"Vraiment je veux que cross-client-testing soit une
matrice parfaite de tout ce qui est possible de faire avec les messageries/communautes"*, and
*"Tester les appels audios et video aussi"*.

Everything above this line grew out of INCIDENTS - a forward that lost a message, a tab that
duplicated one, a group that would not heal. That is why the campaign had eleven checks on sending a
message and none at all on editing one: nobody had reported an edit. A matrix is the opposite
construction. It starts from the feature surface, so a hole is visible as an empty cell rather than
as the absence of a memory.

The surface was inventoried from the code, not recalled, on 2026-08-11. Two things came out of that
inventory before a single check ran, and both are recorded below rather than in a phase: the
**negative rows** (things that do not exist, so nothing may test them and nobody may "fix" them by
reflex) and the **doc rot** it exposed.

**Read the transport column.** This app has three completely different delivery mechanisms, and a
check that does not know which one it is exercising will draw the wrong conclusion from its result:

| World | What travels | Who can read it |
| --- | --- | --- |
| DM and group | MLS `AppMessage` protobuf, `POST /api/mls/send`. Every MUTATION too - edit, delete, read receipt, pin, reaction removal - as a `SystemMsg{event, data}` sent `silent=true` | members only; the server stores ciphertext |
| Community channel | REST on social-service + a Redis broadcast relayed by the gateway. Server-held `masterSecret` per epoch, NOT MLS | the server, in cleartext, for everything except message bodies |
| Ephemeral | WebSocket JSON: `ping`, `disconnect`, `welcome_request`, `typing`. Nothing else | online peers, now, or never |

The consequence that catches people: **a mutation sent `silent=true` is excluded from the Redis
history stream and delivered only per-device from the queue.** So "did the edit arrive" and "did the
message arrive" are not the same question and do not share a failure mode.

## MUT - editing, deleting, reacting, pinning

The four things a user does to a message that already exists. All four are MLS system events in a
DM or a group, and all four are REST calls in a channel - so **every row runs twice**, once in the
two-account DM and once in `Campagne de test`, and the two results are recorded separately.

| Id | What it asks | Venue | State |
| --- | --- | --- | --- |
| MUT-1 | Edit a text message: both sides show the new text and an edited marker | DM | `pending` |
| MUT-2 | Edit clears `readBy` - the receipt restarts, and the sender's "read" indicator goes back | DM | `pending` |
| MUT-3 | Edit is refused on a message with media, and on someone else's message | DM | `pending` |
| MUT-4 | Edit a message the peer has NOT yet received: peer must end up with the edited text, once | DM | `pending` |
| MUT-5 | Edit is absent in channels by design - assert the control is not offered | Channel | `pending` |
| MUT-6 | Delete a message: both sides show the tombstone, not a gap | DM | `pending` |
| MUT-7 | The tombstone WINS over a body on merge - a device holding the original must not resurrect it | DM | `pending` |
| MUT-8 | Delete in a channel is a HARD row delete, no tombstone: assert the difference is real | Channel | `pending` |
| MUT-9 | A moderator deletes another user's channel message | Channel | `pending` |
| MUT-10 | The toolbar offers Delete to a moderator in a DM, where the handler refuses it | DM | `pending` - **a suspected defect, see the negatives** |
| MUT-11 | React, un-react, re-react; two users on the same message; the same user with several emoji | both | `pending` |
| MUT-12 | The 15-distinct-emoji cap, on both transports | both | `pending` |
| MUT-13 | A reaction pushes a notification to the message author only, never to the reactor | DM | `pending` |
| MUT-14 | Pin and unpin, seen on the OTHER device | both | `pending` |
| MUT-15 | A DM pin does not survive on a fresh device - localStorage-only, no history replay | DM | `pending` - expected to fail; it is a real hole |
| MUT-16 | A channel pin DOES survive, because it is re-hydrated from the server | Channel | `pending` |
| MUT-17 | Edit, then delete, then react to the deleted message | DM | `pending` - the absurd crossing |
| MUT-18 | Two devices of the SAME user edit the same message at once | DM | `pending` |
| MUT-19 | Delete a message that is still in the outbox, unsent | DM | `pending` |
| MUT-20 | Mutate a message older than the 90-day server retention window | DM | `pending` |

## READ - receipts, unread counts, and what syncs

Read state is per-USER, never per-device, and the unread count is **never persisted** - it is
recomputed from `readBy` on every batch. That is what makes this phase worth running: a recomputed
number is a number that can be recomputed differently.

| Id | What it asks | State |
| --- | --- | --- |
| READ-1 | Reading on W1 clears the unread badge on W1 and marks it read for the sender | `pending` |
| READ-2 | The SAME user's other device also clears - a receipt from yourself resets your own count | `pending` |
| READ-3 | The receipt only fires with the window FOCUSED and the tab visible: a background tab must not mark read | `pending` |
| READ-4 | The 2 s debounce batches: reading twenty messages sends one receipt with twenty ids | `pending` |
| READ-5 | "Seen by" resolves to display names, and to `+N` past three | `pending` |
| READ-6 | Channels send no receipts at all, by design - and their read state comes from the server tally | `pending` |
| READ-7 | Unread count after a reload, with the receipt still in flight | `pending` |
| READ-8 | Unread count on a conversation whose messages arrived while logged out | `pending` |
| READ-9 | Read on A1 while W1 is open: the count on W1 goes without a reload | `pending` |
| READ-10 | Reading a conversation whose peer has deleted it | `pending` - crosses DEL |

## TYPE - typing indicators

Ephemeral, online-peers-only, never queued: the phase is short because there is almost nothing to
persist, and that is itself the thing to assert.

| Id | What it asks | State |
| --- | --- | --- |
| TYPE-1 | Typing on W1 shows on W2 within a second, and clears on stop | `pending` |
| TYPE-2 | It expires on its own after 6 s if the stop is never sent | `pending` |
| TYPE-3 | Killing the tab mid-typing leaves no stuck indicator on the peer | `pending` |
| TYPE-4 | An offline peer gets nothing, and nothing is replayed when it returns | `pending` |
| TYPE-5 | Channel typing, which is a different transport entirely (REST, not WS) | `pending` |

## SEARCH - finding a message

Search is client-side, in-conversation, substring-only. There is no server index and no global
search, so the phase measures what the local store actually holds - which makes it a second,
independent probe of the same loss class `recon.mjs` measures.

| Id | What it asks | State |
| --- | --- | --- |
| SEARCH-1 | A term in a recent message is found and highlighted, prev/next walk the hits | `pending` |
| SEARCH-2 | A term only in OLD history: does the `searchLimitedToLoaded` flag tell the truth? | `pending` |
| SEARCH-3 | Deleted messages are excluded; edited messages match their NEW text, not the old | `pending` |
| SEARCH-4 | Channel search pulls up to 2000 rows and decrypts them - time it, and watch for a stall | `pending` |
| SEARCH-5 | Accents and case: a French corpus is the real corpus here | `pending` |
| SEARCH-6 | The sidebar filter is a DIFFERENT search (name + last message) - assert it does not claim more | `pending` |

## MENTION - @ and what it triggers

| Id | What it asks | State |
| --- | --- | --- |
| MENTION-1 | The autocomplete inserts the `@[uuid]` token, and it renders as a chip linking to the profile | `pending` |
| MENTION-2 | In a CHANNEL, the mentioned user gets a push even at level `mentions` | `pending` |
| MENTION-3 | At level `none`, the mention gets nothing | `pending` |
| MENTION-4 | In a DM or group a mention triggers NOTHING extra - assert it, do not assume it | `pending` |
| MENTION-5 | Mention a user who is not a member of the channel | `pending` |
| MENTION-6 | The channel path sends `mentionedUserIds` in CLEARTEXT - confirm the leak is the documented one and nothing more | `pending` |

## CALL - audio and video

**The largest hole the inventory found.** Calls have four unit-test files, zero harness scripts,
zero `test_adb.py` coverage and no phase at all - and they are the feature with the most moving
parts: an SFU, a TURN provider, a 5-minute room token, MLS-exported media keys, insertable streams,
CallKit on one platform and a full-screen intent on the other.

Media is encrypted with a key exported from MLS (`exportSecret(groupId, 'mls-webrtc-media',
callId, 32)`) and applied per encoded frame. **If the browser does not support the transform, the
call silently degrades to SFU-visible DTLS-SRTP** and a store flips to false. Asserting that store
is therefore part of every call check, not a separate one.

| Id | What it asks | State |
| --- | --- | --- |
| CALL-1 | 1:1 audio W1 -> W2: ring, accept, two-way audio, hangup on either side | `pending` |
| CALL-2 | 1:1 video: both streams render, and the E2E transform is ACTIVE - not the degraded path | `pending` |
| CALL-3 | Group call in a 3-member group, one leg on A1 | `pending` |
| CALL-4 | Decline: the callee stops ringing - and the caller learns nothing, which is the current design | `pending` |
| CALL-5 | Cancel before answer: `ring-end` reaches every device including the caller's siblings | `pending` |
| CALL-6 | Answer on A1 while W1 is also logged in: W1 stops ringing (sibling suppression) | `pending` |
| CALL-7 | Unanswered: 60 s native timeout fires on the phone; the WEB side has no timeout at all | `pending` |
| CALL-8 | Toggle mute, toggle camera mid-call, and camera-on from an audio-only start (renegotiation) | `pending` |
| CALL-9 | Speaker/earpiece routing on A1 | `pending` |
| CALL-10 | Incoming call with the app KILLED: FCM high-priority wakes it, full-screen intent, deep link answers into the right conversation | `pending` |
| CALL-11 | The same in forced Doze | `pending` |
| CALL-12 | Incoming call on the LOCK SCREEN, answered without unlocking - then what the PIN gate does | `pending` |
| CALL-13 | iOS CallKit end to end: VoIP push, native UI, answer, `pending_call_accept.json`, auto-accept | `pending` - **never run on hardware** |
| CALL-14 | A call is refused in a community channel, by design | `pending` |
| CALL-15 | The room token expires (5 min): start a call, hold the invite, accept late | `pending` |
| CALL-16 | Network drop mid-call - **expected to end the call**, there is no ICE restart. Confirm the UI says so | `pending` |
| CALL-17 | A second incoming call while already in one - **expected to vanish silently**. Confirm, then decide | `pending` |
| CALL-18 | The missed-call system message: who it names and on whose device | `pending` - **a suspected defect, see the negatives** |
| CALL-19 | Call system messages survive a reload and appear on a second device | `pending` |
| CALL-20 | Start a call, then the peer deletes the conversation | `pending` - crosses DEL |

## COMM - communities, channels, roles

A community is a `Workspace`, and **its membership is not MLS membership**. A kick rotates a
server-held epoch key; it commits nothing. Every row here must therefore be read against `MSG-5`'s
standing assertion: **no `masterSecret` in any payload, ever**.

| Id | What it asks | State |
| --- | --- | --- |
| COMM-1 | Create a community, create a channel, post, both peers converge | `pending` |
| COMM-2 | Invite link: create, preview, accept from the other account | `pending` |
| COMM-3 | An expired link, a `maxUses`-exhausted link, and a link to a deleted community | `pending` |
| COMM-4 | Direct invite: the `channel_invitation` card appears in the 1:1 DM on both sides, deduped | `pending` |
| COMM-5 | Roles: promote to moderator, then admin; the permission grid takes effect immediately | `pending` |
| COMM-6 | A custom role with a hand-picked permission set | `pending` |
| COMM-7 | `writePolicy` = admins only: the composer is refused for a member, server-side as well as in the UI | `pending` |
| COMM-8 | Private channel: a non-allowed member cannot see it - **and cannot fetch it by id either** | `pending` |
| COMM-9 | Kick from a channel: the key rotates, and the kicked device can no longer decrypt NEW messages | `pending` |
| COMM-10 | Kick from a channel: the kicked device can still decrypt the OLD ones it already holds | `pending` |
| COMM-11 | Kick from the COMMUNITY, which carries no channel id: the client purges the whole workspace | `pending` |
| COMM-12 | Re-invite a kicked user: they get the new epoch and not the old one | `pending` |
| COMM-13 | Manual key rotation with both sides online, and with one side offline | `pending` |
| COMM-14 | Channel notification levels `all` / `mentions` / `none`, enforced server-side | `pending` |
| COMM-15 | Polls: create, vote, close; auto-pinned | `pending` |
| COMM-16 | Delete a channel, then a community; the client drops them and the slug stays reserved | `pending` |
| COMM-17 | Reorder communities by drag and drop; the order survives a reload and reaches the other device | `pending` |
| COMM-18 | Deep link into a channel from a cold start | `pending` |
| COMM-19 | The last admin leaves a community | `pending` - the absurd one, and nothing in the inventory says what happens |
| COMM-20 | Two admins change the same role at the same moment | `pending` |
| COMM-21 | A member is kicked while composing a message in that channel | `pending` |
| COMM-22 | `hydrateChannelHistoryKeys` on a channel with many epochs - time it | `pending` |

## GRP - group membership, invitations, and the member picker

Split out of DEL once the DEL-1 rig found a defect in a control nobody had ever asserted on.

| Id | What it asks | State |
| --- | --- | --- |
| GRP-1 | Create a group, add a member, both sides see the roster and the Add commit merges | `passed` 2026-08-11 - the `testgroup.mjs` fixture, exercised by every DEL and GRP run |
| GRP-2 | **The member picker offers users who are ALREADY members, yourself included, and inviting one changes nothing without saying so** | `failed` 2026-08-11 -> fixed and re-verified on prod (`grp2.mjs`) |
| GRP-3 | Remove a member: the Remove commit, and what the removed device can still read | `pending` |
| GRP-4 | The group invitation LINK: generate, open it on the other account | `pending` |
| GRP-5 | Rename a group, seen on the other side | `pending` |
| GRP-6 | Leave a group - which deliberately commits nothing | `pending` |
| GRP-7 | Add a member who is offline; they join on their next connection | `pending` |
| GRP-8 | Add and remove the same member twice in a row, fast | `pending` |
| GRP-9 | A member row rendering a raw user id instead of a display name | `pending` - **observed on 2026-08-11**, same class as the `Utilisateur inconnu` fixes |

**GRP-2, as observed.** On a group whose only member is the creator, typing one's own username in
the picker returns one's own account as a selectable option; picking it enables *Envoyer
l'invitation*; submitting closes the picker with no error and the roster stays at one. Two things
are wrong and they are worth separating: the picker should not offer an existing member, and a
submission that cannot do anything should not report success by closing. It was found because a
harness script took the first option in the list, invited the account it was already running as,
and then waited sixty seconds for a peer that had never been invited - see
[testing-methodology](testing-methodology.md).

## The negative rows - what does NOT exist

Written down so that no check is invented for them, and so that nobody "fixes" one by reflex during
a run. Each was confirmed absent in the code on 2026-08-11, not merely unremembered.

**Messages.** Delete-for-me-only. Editing a channel message. A tombstone for a channel deletion (it
is a hard row delete). Disappearing, expiring or view-once messages of any kind. Chat drafts - the
composer is plain component state, so switching conversation loses it. Global or cross-conversation
search, any server-side index, and any search filter. A mention notification in a DM or group. A
read-receipt privacy toggle. An edit time window or edit history. A per-recipient *delivered* ACK -
`sent` means the server accepted the POST and nothing more. Any "forwarded from" attribution.

**Calls.** Screen share. Camera flip. A busy signal. Any signal back to the caller when the callee
declines. ICE restart or any mid-call reconnection. Android `ConnectionService`/Telecom. Any
participant cap. A call-history screen - the history is the system bubbles in the thread.

**Communities.** Join requests or approval. Bans. Renaming a community. A community description. A
channel description or topic. Channel reordering (only communities reorder). A community-level mute.
An endpoint to revoke an invite link, though the `revoked` column exists. Any MLS involvement in
community membership.

**Three of these are gaps rather than decisions**, and they get a check that is expected to fail
rather than a shrug: a DM pin never reaches a fresh device (MUT-15); a reply quote keeps showing the
snapshotted preview of a parent that has since been deleted, and jumping to it lands on the
tombstone; and `recordCallMissed` is invoked with the LOCAL user's id on the caller's own device, so
the caller sees "appel manque de <themselves>" while the callee who never answered gets no missed
record at all (CALL-18). None is a Work Package until a check captures it.

**And the docs are wrong in four places** the inventory tripped over, all cheap to fix and none of
them a defect in the product: `docs/wiki/protocols/websocket-protocol.md` documents a `WsEnvelope` /
`ReadAck` protobuf path that no Rust code references; `docs/wiki/frontend/modules/calls.md` names
call states `outgoing`/`active` where the code says `calling`/`incall`, and lists four call
components where there is one; `docs/wiki/services/chat-delivery.md` still carries `LIVEKIT_*`
environment variables and calls the room token a "LiveKit room token" when the SFU is the in-repo
Rust `call-service`; and the TURN TTL is documented at 3600 s and coded at 7200.

## CORRUPT - deliberate store damage

**Runs last.** It destroys state, and SETUP-8's archive is the only way back that does not cost a
full re-enrolment.

| Id | Corruption | State |
| --- | --- | --- |
| CORRUPT-1 | Truncate the MLS state to half its length | `deferred` - explicit failure + recovery, never a silent empty history |
| CORRUPT-2 | Flip one byte inside the ciphertext | `deferred` - the AEAD tag must fail; detected as tampering |
| CORRUPT-3 | Web vault blob replaced with valid base64 of garbage | `deferred` - must surface, not hang |
| CORRUPT-4 | Zero-length MLS state | `deferred` - treated as absent, clean re-enrolment |
| CORRUPT-5 | An MLS state in an OLDER envelope format | `deferred` - **this is what proves the at-rest compatibility rule**. Keep a copy from before every format change |
| CORRUPT-6 | Delete `push_context.json` while killed, then push | `deferred` - recover or fail loudly, never a decrypt loop |
| CORRUPT-7 | Drop an object store from the web message store mid-session | `deferred` |
| CORRUPT-8 | A wrong-user MLS state restored under another account | `deferred` - **security-relevant: a pass that "works" is a finding** |
| CORRUPT-9 | Fill the data dir until writes fail, then receive | `deferred` - no half-written save |
| CORRUPT-10 | Kill the process **during** an MLS state write | `deferred` - never a half-file read as valid |

### The at-rest artefacts these target

Enumerated for real at SETUP-7, not guessed - a corruption test written against a guessed key name
tests nothing and passes silently. **The web artefacts are keyed by the USER id**
(`CanariDB_<userId>`, `mls_device_id_<userId>`, `canari_last_active:<userId>`,
`history_*:<userId>:<conversationId>`), so a test hardcoding one client's key silently no-ops on the
other. The device id is what the SERVER knows the client by; it names no local artefact.

**This table said `<dev>` until 2026-08-11, and the correction was itself paid for.** A probe built
the names from the documented pattern, reported "DB ABSENT" for both databases, and was believed for
a moment before the source settled it ([indexeddb.ts:33](../../frontend/src/lib/db/indexeddb.ts),
[hex.ts:46](../../frontend/src/lib/utils/hex.ts)). Worse than the wrong answer is what producing it
cost: **`indexedDB.open(name)` CREATES when the name is absent**, so the guess did not fail - it
manufactured two empty databases inside each profile under test and then declared the real ones
missing. They were deleted the same minute, asserting zero object stores before removing anything
and re-enumerating after. Any check that reaches for a web artefact must enumerate
`indexedDB.databases()` and match, never construct a name.

| Client | Artefact | Path / key |
| --- | --- | --- |
| Web | MLS state | IndexedDB `CanariDBMls_<userId>` v1, store `state` |
| Web | message store | IndexedDB `CanariDB_<userId>` v6: `conversations`, `messages`, `outbox` |
| Web | device key vault | `sessionStorage.canari_device_key_vault` + `…_vault_key` |
| Web | vault persistence flag | `localStorage.canari_device_key_persist` |
| Web | device id, last active, saved user | `localStorage.mls_device_id_<dev>`, `canari_last_active:<dev>`, `canari_saved_user` |
| Web | WS auth | cookie `canari_ws_token` - the only cookie readable from JS |
| Android | MLS state | `mls.bin`, at the app data **ROOT**, not under `files/`. ChaCha20-Poly1305, `[nonce 12 \|\| ct]`, **no version field** |
| Android | message store | `canari_<dev>.db` + `-wal` + `-shm`. **WAL mode, and the WAL is where the data is** - corrupting the `.db` alone tests nothing |
| Android | pending MLS, channel keys, push context | `mls_pending.db`, `channel_keys.json`, `push_context.json` |
| Android | device key | `shared_prefs/keystore_aliases.xml`, `<alias>_ct` / `_iv` |
| Android | push secret, native flags, app log | `pending_push_secret.txt`, `fcm_token.txt`, `native_flags.json`, `logs/Canari.log` |
| Android | WorkManager | `no_backup/androidx.work.workdb*` |

`run-as` reaches all of it **only because the installed build is debuggable**; a release build
refuses outright. Worth recording what is NOT there: **no access token in any web storage**, on
either client - the "access tokens in memory ONLY" rule holding in production.

---

## What the campaign has produced

Fourteen defects, every one found by a check or by the log of a check. The narrative of each is in
`CHANGELOG.md`; the rule each taught is in `CLAUDE.md`; open ones are Work Packages there.

| Defect | Found by | State |
| --- | --- | --- |
| **WP-LOSS-1** - a reload rewinds the sender's ratchet, and the receiver silently drops the next message | FWD-3 / FWD-5, then reconciliation | shipped, both halves verified on Android 2026-08-11: the trigger delivers 6/6 with zero `LOST frame`, and the repair heals 14/14 on a forced rewind |
| **WP-HIDDEN-1** - a backgrounded tab stops receiving, silently | TAB-4 | shipped, verified |
| **WP-MULTITAB-1** - two tabs of one account diverge their ratchet | TAB-4 | shipped, verified (9/9 where it lost 4 of 9) |
| **WP-ECHO-1** - the sender loses its OWN message across a reload | reconciliation | shipped; verified on the web, on the phone 2026-08-11 (5 sends INSIDE a bulk window, 11/11 after a reload) |
| **WP-SQLTXN-1** - a pooled connection made `BEGIN` and `COMMIT` two conversations, so writes failed for good | the noise of a VOID run | shipped; verified on the phone 2026-08-11 (25 drains, zero of the three error strings) |
| **WP-PENDING-1** - a catch-up pull that can never make partial progress | LIFE-6 | shipped; verified on the phone 2026-08-11 against a built backlog (1 100 sends into a parked A1: 2 pages, a `Drain start` between them, two ACK steps server-side, depth to 0). The ORIGINAL 10 s timeout is **not** reproduced by that run and is not claimed - see [chat-delivery](services/chat-delivery.md) |
| **WP-PENDING-2** - a frame too far ahead was ACKed off the server as delivered | LIFE-6 | shipped, seen firing end to end |
| **WP-DRAIN-1** - a recovery awaited inside the drain, deadlocking it | verifying WP-HIDDEN-1 | shipped |
| **WP-GHOST-1** - a revoked device wrote its own routing membership back | the queue's size | shipped + verified on prod (98 210 rows -> 0) |
| **WP-NOTIF-1** - an Android notification not dismissed when read elsewhere | NOTIF-4 | shipped, verified on the device |
| **WP-DEEPLINK-1** - the deep-link plugin was never granted its permission | NOTIF-7b | shipped, verified on the device |
| **WP-RELOAD-DL-1** - a WebView reload replays the launch deep link | the log of a **passing** re-run | shipped, verified on the device 2026-08-11 with a negative control that re-creates it on demand |
| **WP-RETRANSMIT-1** - a decrypt-failure repair that fed itself | a user noticing a sync banner | shipped, then the whole mechanism deleted |
| **WP-HISTBANNER-1** - two peers both awaiting history waited on each other for ever | the user seeing the banner on a healed conversation | shipped, verified live on prod 2026-08-11 |
| **WP-ANR-1** - the MLS state decoded one byte at a time, freezing the app after every store update | the user seeing "Canari ne repond pas" | shipped; verified on the phone 2026-08-11 (110 queued, `MY_PACKAGE_REPLACED` drained in **2 331 ms** of a 60 000 ms deadline where it took 58 600, with 100 encrypts on **one** keystore load and zero ANR - on a DEBUG build, so release clears it a fortiori) |

Still open and needing a decision rather than a patch: **WP-KBD-1** (the composer behind the soft
keyboard) and **WP-DRAIN-2** (the inbound drain has no watchdog). **WP-DIRECTBOOT-1**, found by
LIFE-5's observation half, was verified on hardware 2026-08-11 and is closed.

### The mechanism every later phase measures was replaced

Decided 2026-08-07, shipped 2026-08-10. The narrow `decrypt_failed` retransmission could not name
what it was missing, so it asked for a blind time window and every peer answered with a broadcast -
which was both the amplification class and the reason a loss noticed after a sender reload was
reported as unrecoverable. It is **deleted**, along with the ring behind it and the nine durations
that arbitrated the ladder. The history diff addresses by identity, reads the durable store and
elects one responder, so it is now the only repair.

Two consequences for this campaign, and they are why the re-run is not a formality:

- **Any repair observed from now on IS the diff**, so the hardest old assertion ("which mechanism was
  that?") is gone. What replaces it is quantitative: **how much traffic did the repair cost?** The
  deleted rung ran at ~450 frames/min for over ten minutes while repairing nothing, so a run whose
  frame rate does not fall back to the ordinary send rate has found something.
- **Every HEAL observation before 2026-08-10 was made against a code path that no longer exists.**

---

## A commit from another contributor owes a WEB pass and a MOBILE pass

His tests establish that his code compiles and that his units behave. They cannot establish that it
RUNS against this deployment, which is the only thing this campaign is for. So each of his commits
that lands in a measured surface gets two observations, and they are not the same observation twice:
a panel can render perfectly in a browser and be empty on a phone, because the two halves are fed by
different code.

The device-storage panels (2026-08-11) are the worked example.

| Pass | What only that pass can see | Verdict |
| --- | --- | --- |
| WEB | The admin panel reads four independent backend measurements, one of them across a service boundary - the exact shape that fails only on a deployment, silently, when a variable is missing from a compose `environment:` block | **PASS** - 4/4 rendered a figure (`Disque`, `Base de donnees`, `MinIO`, `Redis`) |
| MOBILE | The client breakdown comes from a NEW Rust command (`get_local_storage_usage`); the web build never calls it, it falls back to `navigator.storage.estimate()`. A Tauri v2 command not granted in `capabilities/` builds, ships, installs and then rejects on a real device (WP-DEEPLINK-1) | **PASS** - four native categories with figures, zero command rejection in the app's own log |

Three things that pass taught, and they generalise to every future one:

- **Assert on what the PAGE rendered, not on a probe of your own.** The first web attempt called the
  admin endpoint with a bare `fetch` and got `403 Operation restricted to global admins` while the
  page beside it showed all four figures - because the access token lives in MEMORY, never in a
  cookie. The 403 was the right answer to the wrong question, and reporting it would have accused
  the app of the harness's mistake.
- **Scope a log filter to the app's own pid.** `logcat -b all` carries the whole platform: an
  unscoped search for `forbidden` counted 26 "command rejections" that were the modem printing
  `Received Forbidden PLMNs`. That verdict would have blamed a colleague's panel for the phone's SIM.
- **Prove WHICH bundle is running, or the run measures the previous one.** An install can succeed
  over a WebView that then serves a cached page. The check compares the loaded
  `_app/immutable/entry/*.js` names against the local build output - and it must read
  `performance.getEntriesByType('resource')`, not `script[src]`: SvelteKit boots from an inline
  module, so a selector-based version of this assertion finds nothing and silently asserts nothing.

## The campaign owns its own debris, and clearing it is a check in itself

Asked by the user on 2026-08-11. A campaign that creates groups, devices and backlogs on the
PRODUCTION database leaves state behind that later runs then measure — and cannot tell from real
traffic. Two classes were cleared that day, and each taught something the runs themselves had not.

**Ten test groups, deleted through the UI and not by SQL.** `DELETE /api/mls/groups/:groupId` emits
nothing to clients: the notice is an E2EE MLS `groupDeleted` system message the CLIENT sends
*before* calling the server, precisely because the server call hard-deletes `dm_group_members` and
strips the routing a later message would need (`groupActions.ts:98`). An `UPDATE` straight into
Postgres would have left the peer holding a live MLS group for a conversation that no longer exists
— manufacturing the exact orphan state this campaign hunts. Going through the UI also exercises
`deleteGroupAndBroadcast`, which no check covers. Verified server-side: all ten tombstoned, zero
members, zero queued. `scratchpad/cleanup-test-groups.mjs` only ever matches the harness's own name
prefixes; a real user's group sat in the same sidebar and was skipped by name.

**One dead browser generation, revoked.** It held 2 073 of the platform's 2 916 queued rows. See
[chat-delivery > the answer was a REVOCATION](services/chat-delivery.md) for why deleting the rows
would have been the wrong shape.

Two rules for any destructive cleanup script, both learnt by nearly getting them wrong here:

- **Name the target, never infer it.** The device dialog labels its rows "Appareil 1/2/3" and shows
  no id, so pressing on an ordinal would have been a guess between this browser, the phone and the
  debris — and a wrong guess destroys a live device's access. The id is in a `title` attribute; the
  script matches on it and **fails** if it does not find exactly one match, rather than falling back
  to a position.
- **Assert the post-condition, not the click.** The delete is asynchronous (MLS broadcast, then the
  server call), so a loop counting clicks reports success for a no-op. Poll until the entry actually
  leaves the sidebar.

## The run plan for the full re-run

Decided by the user 2026-08-11: **re-run everything, to the end, fixing what comes up as it comes
up.** No Work Package is open on any repository, so nothing competes with it. The order below is not
a preference - each step is entered only once the one before it has proved something the next one
assumes.

**Decisions taken 2026-08-11 before the run, not to be re-litigated:**

- **A defect is fixed and pushed the moment it is found.** Prod is the test server, so the fix is
  verified RUNNING - which is the only thing this campaign is for. Consequence accepted: every deploy
  invalidates the loaded bundle, so `bundle-id.mjs` runs again after each one.
- **Then EVERY check the fix could touch, however remotely, is re-run - err wide.** The user's
  instruction, verbatim: *"quand tu fixes quelque chose, il faut refaire tous les tests qui peuvent
  etre touches de pres ou de loin par ce que tu as fait, vois large"*. The scripts exist, so a wide
  re-run is cheap and a narrow one is a guess about a blast radius nobody has measured. Judging a
  check unaffected is a claim, and this campaign has been wrong about exactly that before: a fix to
  the drain explained a tab defect, and a fix to the ratchet explained an echo defect.
- **The destructive phases proceed unattended**, PIN and CORRUPT included - PIN-2's repeated
  rejection, PIN-4/5's change, PIN-6's removal, and all ten corruptions. The floor under it is
  SETUP-8's archive plus the fact that a full re-enrolment is always possible; it costs the 2FA.
- **The two steps no tool can perform are BATCHED to the end**, not asked for as they arise: the
  owner account's 2FA (any re-login) and the unlock pattern after LIFE-5's reboot. So LIFE-5 and
  every re-login check leave the ordered plan below and run last, together, once the user is warned.
- **The phone is free**: reboots, radio cycles, forced Doze and `install -r` need no warning.
- **Every fix also pays down the cost of the NEXT check.** The user's standing instruction, given
  2026-08-11: *"si tu dois faire un fix, profite pour rendre les tests suivants plus rapides et plus
  faciles"*, and, on accessibility, *"ca aide aussi pour les tests automatisees, donc c'est avec
  grand plaisir"*. The two are the same instruction: an `aria-label`, a `role="option"`, a stable
  `id` is simultaneously the thing a screen reader announces and the thing a harness can select on,
  and both are more durable than a Tailwind class or a portal's screen position. This applies to the
  whole roadmap, not to one phase.

**Pre-flight, and none of it is a check.** A run that skips this measures the previous build.

| Gate | Why it is a gate | Measured 2026-08-11 |
| --- | --- | --- |
| Prod version + `minClientVersion` | A client below the floor is bounced, and the run would be measuring the bounce | `0.13.1` / `0.13.0`, maintenance off |
| `git fetch` | Another contributor pushes to `main`; the local tree is not the deployed truth | in sync at `aefdb81a` |
| `bundle-id.mjs` on W1 and W2 | A browser left open across a deploy runs yesterday's code and logs are read as if it did not | owed at the start of the run |
| `pin.mjs --port 9224 --account owner` | A launch, kill, reboot, radio cycle or `install -r` re-locks the PIN | owed - both browsers were relaunched on 2026-08-11 |
| A1 present and DEBUGGABLE | `run-as` is how every at-rest assertion reads the phone; a release build refuses | `fr.emse.canari` 0.13.1, DEBUGGABLE, `mls.bin` 1 618 509 B, logged in as **owner** |
| The two profiles hold their identity | `chrome-w1` / `chrome-w2` ARE the devices | fingerprinted, unchanged across the move |

**Then, in this order.**

1. **MSG**, all eleven. The baseline exists so that every later failure can be told from a rig that
   was already broken - and it must be re-proved in the SAME session, not cited from a previous one.
2. **FWD**, all five. It is where the campaign's central defect lives, and it needs nothing but MSG.
3. **TAB**, all seven - including TAB-1 and TAB-7, which have never run.
4. **LIFE** then **NOTIF**. Both need A1 and a logcat capture running; NOTIF-2/3/5/6 have never run.
   LIFE-5 needs the user once, for the unlock pattern after the reboot.
5. **HEAL**, W1 through W4, and only here: it rewinds W1's ratchet in EVERY group, so it must not
   precede a check that would then blame the app for a lossy link. Take the `mlsdb.mjs` snapshot
   first, `bundle-id.mjs` first, record which device answered, and let the teardown restore the
   invariant rather than a snapshot. W4 has no prior art on either client.
6. **MULTI**, six checks, none of which has ever run.
7. **PIN**, ten checks, none of which has ever run. After HEAL because PIN-3 probes the lockout rule
   and a lockout blocks everything downstream.
8. **CORRUPT**, last, because it destroys state and SETUP-8's archive is the only way back that does
   not cost a re-enrolment.

**Reconciliation runs after every phase, not once at the end.** `recon.mjs` is the only thing that
can SEE this codebase's loss class, and a diff taken only at the end cannot say which phase opened
it.

**Convergence measurements**, once the phases are through: the per-thread marker diff between W1 and
W2; the queued-message counts on prod against what each client shows; `DeviceGroupMembership`
against live key packages (the WP-GHOST-1 predicate - zero violations when last checked 2026-08-10).

Small items owed, one check each: the backup export's Tauri branch; the `LinkPreviewCard` case of
the link-safety check; the mobile pass of the OIDC custom-tab change.

**Anything needing a logout and re-login is last**, and needs the user: the owner account's 2FA
cannot be answered by the harness.

**Then clean up.** The campaign creates groups, devices and backlogs on the production database that
the NEXT run then measures and cannot tell from real traffic. The two rules a destructive cleanup
script must follow are in the debris section above.

### State to carry into the run, measured 2026-08-11

**Seven awaiting-history markers were already set** - three on W1, four on W2, every one of them
carrying the PROVEN reason `unreadable-frames`. They were audited before MSG-1 rather than left to
fire inside it, and the audit settled two different questions and found one defect.

| Marker | Conversation row | What a reconnect does with it |
| --- | --- | --- |
| 1 of 3 on W1 (= 1 of 4 on W2) | present on both | solicited - it is the DM under test |
| the other 5 | none | nothing: `reSolicitAwaitingHistory` skips any group not held locally |

**The live one is CORRECT and must not be "fixed".** A reconnect produced the full round trip:
`[HISTORY_REQ] re-soliciting bundle ... (awaiting across sessions)` -> a range-mode digest, 256
slices at depth 2 -> the peer answering `0 to send, 0 to pull (identical stores)` with an empty,
explicitly **not vouching** bundle -> `attempt ... settled`. The marker deliberately survives that:
an empty unvouched bundle cannot discharge `unreadable-frames`, because a frame BOTH devices lack is
still lost and only a third device can produce it. The banner does NOT show, because the pending
phase cleared - which is WP-HISTBANNER-1's fix working, the responder ANSWERING rather than staying
silent. The third device that could actually discharge it is A1, which holds the same account as W1.

**Exactly one of the three W1 markers was solicited**, which is the skip working, measured rather
than argued.

**The five orphans exposed WP-HISTGHOST-1**, fixed the same day: an awaiting-history marker, its
reactive phase and its scheduled burst all outlived the conversation they described, and the
reactive one is user-visible - a conversation deleted by the peer keeps its row on purpose
(`lifecycle: 'removed'`) and kept rendering "L'historique est en attente" over it, permanently,
since every clear path waits for an answer that a deleted group cannot send. See `CHANGELOG.md`.

The first analysis of those orphans was WRONG and the way it was wrong is the lesson: they were
declared inert after enumerating ONE consumer of the marker (the solicitation, which does skip
them). The banner is another consumer, and it does not skip. One surface handling a case is not the
case being handled - the user had seen the banner in production and said so.

- W1 holds 6 conversations / 1 880 messages, W2 holds 1 / 1 804. A HEAL check that rewinds W1
  rewinds all six.
- W1 holds 6 conversations / 1 880 messages, W2 holds 1 / 1 804. A HEAL check that rewinds W1
  rewinds all six.
- `heal-w2.mjs`'s verdict was rewritten on 2026-08-11 and its old form **could not pass**: it
  required a branch four runs proved unreachable. It now gates on the break having taken, and asks
  the question the `1e8208d6` fix created - see the HEAL-W2 section above.
