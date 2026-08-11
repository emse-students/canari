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

- **Seven awaiting-history markers are already set** - three on W1, four on W2. Each one re-solicits
  history on the first reconnect, so they will fire during the very first check of the run and must
  not be read as that check's doing. Whether they are legitimate pending state or residue of
  WP-HISTBANNER-1 is itself worth settling before MSG-1.
- W1 holds 6 conversations / 1 880 messages, W2 holds 1 / 1 804. A HEAL check that rewinds W1
  rewinds all six.
- `heal-w2.mjs`'s verdict was rewritten on 2026-08-11 and its old form **could not pass**: it
  required a branch four runs proved unreachable. It now gates on the break having taken, and asks
  the question the `1e8208d6` fix created - see the HEAL-W2 section above.
