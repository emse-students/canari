 `passed` 2026-08-13 | Where | What it holds |
| --- | --- |
| this page | every check, its rung, its state |
| [testing-methodology](testing-methodology.md) | how a result earns the right to be believed - 31 harness faults distilled into ten rules |
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
> **The rig is [`tools/cross-client-harness/`](../../tools/cross-client-harness/README.md) in this
> repository** - the scripts that run, not a copy of them. Its README is the operating manual.
>
> **Its STATE is deliberately outside**, in a sibling directory `../canari-harness`: the account
> file, the two Chrome profiles (which ARE W1 and W2 - their MLS identity, their history, their
> login), the verdict record, the APK and the phone baseline. One constant, `STATE_DIR` in
> `names.mjs`, bridges the two. Credentials outside the work tree **cannot** be committed, which is a
> structure; a `.gitignore` rule would only be a policy, and this repository is public.
>
> The two accounts appear here only as **owner** (W1, A1) and **peer** (W2). No PIN, login, display
> name, device id or group id belongs on this page.
>
> **Every test message goes in the owner-peer DM, and nowhere else.** A one-off probe once fired a
> "dangerous link" warning into a real colleague's thread. Anything needing a CHANNEL uses the
> `Campagne de test` community - never MiTV, whose private channels are readable by every
> association admin.

---

## Where the campaign stands

**Updated after every run - this table is the monitor, not a summary written at the end.**

| Phase | Scripts | State |
| --- | --- | --- |
| SETUP | - | 5 of 9 `passed`; SETUP-2 deliberately skipped, SETUP-7/8 owed (8 before CORRUPT and PIN) |
| MSG | 12 | 13 of 13 `passed` 5/5 on `8a3edbdd`, then `e62c21f1`, then **`25376b86`: 65 verdicts, 65 `PASS`** |
| TYPE | 5 | 5 of 5 `passed` 5/5 on `8a3edbdd`, then `e62c21f1`, then **`25376b86`: 25 verdicts, 25 `PASS`** |
| READ | 10 | 8 of 8 runnable `passed` 5/5, 40 of 40 clean; READ-5 and READ-10 `blocked` (a 4th reader, `--destructive`) |
| FWD | 5 | 5 of 5 `passed` - FWD-1/3/4/5 5/5 with every server window clean, FWD-2 25/25 delivered by hand |
| every other phase | 22 written, 6 with none | `pending` - not yet run on this build |

Each phase section below names the build its row ran against; this table is the index, not the
evidence. **A phase re-runs when a commit touches the surface it measures** - which is why MSG and
TYPE carry two builds each.

**THE ORDER IS THIS FILE'S OWN NUMBERED LADDER, AND THERE IS NO OTHER.** Run the phase sections
below top to bottom: 1 MSG, 2 TYPE, 3 READ, 4 MUT, 5 SEARCH, 6 MENTION, 7 FWD, 8 GRP, 9 COMM,
10 DEL, 11 TAB, 12 MULTI, 13 LIFE, 14 NOTIF, 15 CALL, 16 HEAL, 17 PIN, 18 CORRUPT. It is ordered by
[tier](#the-ladder), so each rung assumes what the one below it proved, and it already carries every
sequencing constraint there is: HEAL before MULTI and PIN because it rewinds W1's ratchet in every
group, PIN after HEAL because PIN-3 probes the lockout, CORRUPT last because it destroys state.
**A second copy of this order was kept outside this file and drifted** - it still read
`MSG -> FWD -> TAB` from before the matrix phases were interleaved, and on 2026-08-15 it sent a run
to FWD straight after READ. It has been deleted. Two orders in two places IS the fault; if the order
needs to change, it changes here.

## State vocabulary

| State | Meaning |
| --- | --- |
| `pending` | not run against the current build |
| `passed` | ran, assertions held, run was clean - **and the row names the build it ran against** |
| `failed` | ran and did not hold - always paired with a Work Package carrying the captured log, or with a fixed commit |
| `blocked` | cannot run until something outside the campaign happens (a decision, the user, a rung above) |

## The three transports - read this before reading any phase

| World | What travels | Who can read it |
| --- | --- | --- |
| DM and group | MLS `AppMessage` protobuf, `POST /api/mls/send`. Every MUTATION too - edit, delete, read receipt, pin, reaction removal - as a `SystemMsg{event, data}` sent `silent=true` | members only; the server stores ciphertext |
| Community channel | REST on social-service + a Redis broadcast relayed by the gateway. Server-held `masterSecret` per epoch, NOT MLS | the server, in cleartext, for everything except message bodies |
| Ephemeral | WebSocket JSON: `ping`, `disconnect`, `welcome_request`, `typing`. Nothing else | online peers, now, or never |

---

## The ladder

| Token | Meaning |
| --- | --- |
| `W1 W2` | the two browsers, both online, nothing else |
| `+A1` | the phone as a third client |
| `+push` | FCM, so the phone AND a background, doze or killed state |
| `+snapshot` | an MLS or app-data snapshot taken **before** the check, because the check breaks something |
| `+user` | a step no tool here can perform: the owner account's 2FA, the lock-screen pattern, a biometric prompt |

### Tier A - the floor

Nothing higher up the ladder can be interpreted until these hold, and they must be re-proved in the
SAME session, never cited from a previous one.

| Rung | Phase | What it adds that no rung below it has | Checks |
| --- | --- | --- | --- |
| 0 | [SETUP](#0---setup) | the rig itself, proven before it is believed | 9 steps |
| 1 | [MSG](#1---msg---the-plain-path) | one message reaches one peer, on both transports | 11 |
| 2 | [TYPE](#2---type---typing-indicators) | the ephemeral socket, which persists nothing - the cheapest possible cross-client assertion | 5 |

### Tier B - what happens to a message that already arrived

One delivered message, and the states hung off it. Each rung adds one mechanism to a path rung 1
proved.

| Rung | Phase | What it adds | Checks |
| --- | --- | --- | --- |
| 3 | [READ](#3---read---receipts-and-unread-counts) | a per-USER durable state, recomputed rather than stored | 10 |
| 4 | [MUT](#4---mut---editing-deleting-reacting-pinning) | the `silent=true` sub-transport, and mutation of state that already converged | 20 |
| 5 | [SEARCH](#5---search---finding-a-message) | a pure local-store read - a second, independent probe of the loss class | 6 |
| 6 | [MENTION](#6---mention---mentions-and-what-they-trigger) | a token inside a body that triggers something outside it | 6 |
| 7 | [FWD](#7---fwd---forwarding) | one message crossing from one transport into the other | 5 |

### Tier C - what happens to the container

The conversation itself changes: members, epochs, existence. Everything here can break a message
path that tier B just proved, which is exactly why it comes after.

| Rung | Phase | What it adds | Checks |
| --- | --- | --- | --- |
| 8 | [GRP](#8---grp---group-membership-and-invitations) | an MLS commit - the first thing that moves an epoch | 9 |
| 9 | [COMM](#9---comm---communities-channels-roles) | the community world: roles, invites, kicks, a server-held epoch key that rotates | 22 |
| 10 | [DEL](#10---del---deleting-a-conversation-crossed) | removal of state that other state still points at | 10 |

### Tier D - several clients, several lifecycles

Now more than one context of the same identity, then the phone, then the phone asleep. A failure
here is attributable because tiers A-C fixed everything a single online client can get wrong.

| Rung | Phase | What it adds | Checks |
| --- | --- | --- | --- |
| 11 | [TAB](#11---tab---tabs-and-windows) | several contexts of ONE client: two tabs, a reload, a cold start | 8 |
| 12 | [MULTI](#12---multi---one-user-two-devices) | one user on two DEVICES - and the `+A1` sweep from tiers B and C | 6 |
| 13 | [LIFE](#13---life---android-lifecycle) | the phone leaving the foreground: background, killed, doze, reboot, offline | 8 |
| 14 | [NOTIF](#14---notif---notifications) | push, which is a lifecycle and a transport and an OS at once - and the `+push` sweep | 11 |
| 15 | [CALL](#15---call---audio-and-video) | the most moving parts in the product: an SFU, a TURN provider, a 5-minute room token, MLS-exported media keys, CallKit and a full-screen intent | 20 |

### Tier E - deliberate damage

Destructive, and ordered by how expensive the way back is. Nothing after a rung here can be trusted
until its teardown has restored the invariant.

| Rung | Phase | What it adds | Checks |
| --- | --- | --- | --- |
| 16 | [HEAL](#16---heal---does-a-broken-group-repair-itself) | a deliberately rewound store, which is the whole loss class made on purpose | 5 |
| 17 | [PIN](#17---pin) | a lockout risk that would block every rung, which is why it is not earlier | 10 |
| 18 | [CORRUPT](#18---corrupt---deliberate-store-damage) | at-rest damage; SETUP-8's archive is the only way back that does not cost a re-enrolment | 10 |

### What the ladder is allowed to contain

Two standing instructions from the user govern the scope, and they are why the ladder covers the
feature surface rather than the incident history:

*"Vraiment je veux que cross-client-testing soit une matrice parfaite de tout ce qui est possible de
faire avec les messageries/communautes"*, and *"Tester les appels audios et video aussi"*.

*"J'ai dit que je voulais tous les tests possibles, qu'ils soient plus ou moins absurdes, plus ou
moins courant. Un test absurde qui provoque une incoherence peut servir dans d'autres contextes que
celui de ce test absurde"*.

So a hole is visible as an empty cell rather than as the absence of a memory, and the absurd
crossings get rows. That is not a hypothesis: the first question ever asked of the DEL phase - which
existed only because deletion had never been a subject, only a step - found a defect sitting in
production.

The complement is the [negative rows](#the-negative-rows---what-does-not-exist): what does NOT exist,
written down so no check is invented for it and nobody "fixes" one by reflex during a run.

## Rules that hold for every check

Decided with the user, not to be re-litigated:

- **A defect is fixed and pushed the moment it is found.** Prod is the test server, so the fix is
  verified RUNNING, which is the only thing this campaign is for. Consequence accepted: every deploy
  invalidates the loaded bundle, so `reload.mjs` runs again after each one.
- **Then EVERY check the fix could touch, however remotely, is re-run - err wide.** Verbatim: *"quand
  tu fixes quelque chose, il faut refaire tous les tests qui peuvent etre touches de pres ou de loin
  par ce que tu as fait, vois large"*. The scripts exist, so a wide re-run is cheap and a narrow one
  is a guess about a blast radius nobody measured. This campaign has been wrong about exactly that:
  a fix to the drain explained a tab defect, and a fix to the ratchet explained an echo defect.
- **Every fix also pays down the cost of the NEXT check.** Verbatim: *"si tu dois faire un fix,
  profite pour rendre les tests suivants plus rapides et plus faciles"* and, on accessibility, *"ca
  aide aussi pour les tests automatisees, donc c'est avec grand plaisir"*. These are one instruction:
  an `aria-label`, a `role="option"`, a stable `id` is simultaneously what a screen reader announces
  and what a harness can select on, and both outlive a Tailwind class or a portal's screen position.
- **Reconciliation runs after every phase, not once at the end.** `recon.mjs` is the only instrument
  that can SEE this codebase's loss class, and a diff taken only at the end cannot say which phase
  opened it.
- **The destructive phases proceed unattended**, PIN and CORRUPT included. The floor under that is
  SETUP-8's archive plus the fact that a full re-enrolment is always possible; it costs the 2FA.
- **The `+user` rows are BATCHED to the end**, not asked for as they arise: the owner account's 2FA
  and the lock-screen pattern after LIFE-5's reboot. **The phone otherwise is free** - reboots, radio
  cycles, forced doze and `install -r` need no warning.
- **The phone runs the assets bundled into its APK.** A wire-protocol change reaches the browsers the
  moment CD is green and reaches A1 only through a new build. Either state the fleet is mixed and say
  which branch each A1 row is therefore reading, or rebuild before the device rungs - but never
  report an A1 verdict without knowing which of the two it was.

**Pre-flight, and none of it is a check.** A run that skips this measures the previous build.

| Gate | Why it is a gate |
| --- | --- |
| Prod version + `minClientVersion` | a client below the floor is bounced, and the run would be measuring the bounce |
| `git fetch` | another contributor pushes to `main`; the local tree is not the deployed truth |
| `reload.mjs` on W1 and W2 | a browser left open across a deploy runs yesterday's code, and its log is read as if it did not. It detects staleness, repairs it, then RE-ASSERTS the build id rather than assuming the reload took |
| `unlock.mjs` | a launch, kill, reboot, radio cycle or `install -r` re-locks the PIN, and a locked client reads as a healthy one on every screen that is not the gate |
| A1 present and DEBUGGABLE | `run-as` is how every at-rest assertion reads the phone; a release build refuses outright |
| The two profiles hold their identity | `chrome-w1` / `chrome-w2` ARE the devices - fingerprint them (device id, MLS blob size, conversation and message counts) |
| `recon.mjs` W1 vs W2 | the campaign starts from a reconciled fleet or it cannot attribute what it finds |
| `[HISTORY_RECONCILE]` quiet on all three | a client still asking for history is state the run will otherwise blame itself for. The old `awaiting.mjs` read a durable registry that the rework removed; the observable is now the LOG line, not a stored key |

---

## 0 - SETUP

Nothing here is a test. It is the harness, and a harness that is not proven produces failures that
belong to itself.

| Id | Step | Needs | State |
| --- | --- | --- | --- |
| SETUP-1 | Build the debug APK, plus the jniLibs `.so` rescue (`test_adb.py` `_ensure_native_lib_present` - a Windows symlink failure builds an APK with no native lib) | `+A1` | `passed` 2026-08-14 - APK rebuilt and installed; the rebuild is part of the pre-flight |
| SETUP-2 | Clean uninstall + install. **Wipes `mls.bin`** - the device loses its MLS identity and local history, by design | `+A1` | `skipped` - deliberate: `install -r` keeps the store and avoids re-paying SETUP-4's 2FA |
| SETUP-3 | Start logcat with the 19-tag whitelist from `test_adb.py`. A tag missing there is a verdict that never arrives | `+A1` | re-run each session - done 2026-08-14 |
| SETUP-4 | W1: log in as **owner**, enrol the device, set the PIN | `+user` | `passed` 2026-08-14 - preflight: unlocked, online at the gateway |
| SETUP-5 | W2: log in as **peer** (no 2FA on that account), set the PIN | `W1 W2` | `passed` 2026-08-14 - preflight: unlocked, online at the gateway |
| SETUP-6 | A1: log in as **owner**. **Decline biometrics** so the PIN is always the unlock path | `+A1` `+user` | `passed` 2026-08-14 - preflight: unlocked, online at the gateway |
| SETUP-7 | **Discovery pass.** Enumerate the real at-rest artefacts rather than guessing them - see [the artefact table](#the-at-rest-artefacts) | `+A1` | `pending` - owed before CORRUPT and PIN |
| SETUP-8 | Baseline snapshot of the intact Android app data, so every corruption test can roll back without a re-enrolment | `+A1` | `pending` - owed before CORRUPT and PIN |
| SETUP-9 | The dedicated venue for channel traffic | `W1 W2` | `passed` 2026-08-13 |

## 1 - MSG - the plain path

State is the last run, `8a3edbdd` x5 (2026-08-14, 20:03-20:21Z). `5/5` = clean on all five passes,
web, mobile and server. Durations are the spread across those five passes. Re-run once on
`e62c21f1` (2026-08-15, 22:28Z) after the banner change touched this surface: **13/13, server clean**.

**RE-RUN x5 ON `25376b86` (2026-08-15, 15:19-15:38Z) - 65 verdicts, 65 `PASS`.** The build carrying
the repair-ask ordering fix, so all three clients were on it. What the run was taken to establish, and
did: `MSG-6/7` **ran** on all five passes (`1 827-1 971 ms`) where it had been `BLOCKED` 5/5 before,
and the `[QUEUE] mailbox barrier ... SKIPPED` line that dirtied pass 1 of the previous run is absent
from all five. Server clean on every pass once the pass-2 window was read: nine `404`s, one burst, an
internet scanner probing for secrets on a public host - nothing served, classified `notable` so it is
reported and gates nothing, and the SSR's habit of printing a 404 through `console.error` filed as a
P3 on [backlog](backlog.md).

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| MSG-1 | W1 -> W2 plain DM: under 2 s, one copy, correct author | `W1 W2` | `passed` 5/5 - 264-326 ms |
| MSG-1-cold | Same, after a reload | `W1 W2` | `passed` 5/5 - 265-311 ms |
| MSG-1b | Delivery DURING a history load | `W1 W2` | `passed` 5/5 - 6-21 ms |
| MSG-2 | W2 -> A1 with the app foreground: no duplicate against the push | `+A1` | `passed` 5/5 - 281-618 ms |
| MSG-3 | Reply renders with its quoted parent on both sides | `W1 W2` | `passed` 5/5 - 331-387 ms |
| MSG-4 | Image then PDF: ciphertext upload, both render, receiver decodes | `W1 W2` | `passed` 5/5 |
| MSG-5 | Channel message converges on all three; no `masterSecret` in any payload | `+A1` | `passed` 5/5 |
| MSG-6 | Link preview served through the proxy, never a third-party `<img src>` | `W1 W2` | `passed` 5/5 |
| MSG-7 | 30 rapid sends: order preserved, no gap, no duplicate | `W1 W2` | `passed` 5/5 - 30/30 ordered, 1 881-1 970 ms |
| MSG-8 | Send to a BACKGROUNDED tab | `W1 W2` `+A1` | `passed` 5/5 |
| MSG-8b | Same, receiver on another page: badge and unread count | `W1 W2` `+A1` | `passed` 5/5 |
| MSG-9 | **Receiver** offline at the GATEWAY, then restored: lands once on reconnect | `W1 W2` | `passed` 5/5 - 15.6 s, nearly all of it the deliberate outage |
| MSG-10 | **Sender** offline: optimistic echo persists, outbox drains, survives a reload | `W1 W2` | `passed` 5/5 |
| (server) | Every application container's log over each pass's own window | - | `clean` 5/5 - ~2 800 lines a pass, nothing unexplained |

## 2 - TYPE - typing indicators

Ephemeral, online-peers-only, never queued: the phase is short because there is almost nothing to
persist, and that is itself the thing to assert. It runs here because it is the cheapest statement
that both clients are really talking to each other, and it leaves nothing behind.

State is the last run, `8a3edbdd` x5 (2026-08-14, 21:33-21:40Z). **5/5 = clean on all five passes**,
web, mobile and server. Shown/cleared are the spreads across those passes. Re-run once on
`e62c21f1` (2026-08-15, 22:32Z) after the banner change touched this surface: **5/5, server clean**.

**RE-RUN x5 ON `25376b86` (2026-08-15) - 24 of 25, then 25 of 25 after the instrument was fixed.**
`TYPE-5` threw on pass 4 of the first series: `openChannel` clicked the `general` row, the click was
RECEIVED by that row, and no composer ever appeared. It could not be attributed, for two reasons that
are now rule 20 of [testing-methodology](testing-methodology.md) - the check waited fifteen seconds
for one state that two opposite causes both produce, and both `watch` windows opened *after* the
setup, so the throw carried no console line from either client. `openChannel` now asserts the row
becoming `aria-current` first (the attribute the screen-reader work had already added) and names
which of the two happened, on which port; `type5` observes its own setup and drains both reports into
the failure record. The re-run went 25/25 with every server window clean, and a third series taken
straight after it exited **`CLEAN 5/5`** on its own - no window needing a rule written after the fact,
which the second series had needed twice. The fault has not recurred in 50 further verdicts and is
therefore **unattributed, not explained**: if it returns, the report will say which half it is.

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| TYPE-1 | Typing on W1 shows on W2 within a second, and clears on stop | `W1 W2` | `5/5` - shown 70-90 ms, cleared 245-272 ms |
| TYPE-2 | It expires on its own after 6 s if the stop is never sent | `W1 W2` | `5/5` - shown 55-122 ms, expired 4 138-4 221 ms |
| TYPE-3 | Killing the tab mid-typing leaves no stuck indicator on the peer | `W1 W2` | `5/5` - shown 70-134 ms, cleared 6 138-6 181 ms |
| TYPE-4 | An offline peer gets nothing, and nothing is replayed when it returns | `W1 W2` | `5/5` - cut acted in 874-995 ms, back in 797-1 173 ms |
| TYPE-5 | Channel typing, which is a different transport entirely (REST, not WS) | `W1 W2` | `5/5` - shown 53-72 ms, cleared 232-331 ms |
| (server) | Every window classified, third-party traffic partitioned out | - | `clean 5/5` - ~330 lines a pass, nothing unexplained |

## 3 - READ - receipts and unread counts

Read state is per-USER, never per-device, and the unread count is **never persisted** - it is
recomputed on every batch. That is what makes this phase worth running: a recomputed number is a
number that can be recomputed differently.

**The carrier is a WATERMARK, not a per-message `readBy` list** - one timestamp per (conversation,
user), compared rather than accumulated, which is what stops a history catch-up marking a read
message unread. The change came with the history-reconciliation rework; anything here still phrased
in terms of per-message ids predates it. What did NOT change is the gate (`isWindowFocused &&
isTabVisible`, no receipt on a channel, none on a conversation the peer deleted), the 2 s debounce,
or the `.msg-status-sent` / `.msg-status-read` selectors the checks locate the anchor by.

**RUN 5x ON `f823496a`, 2026-08-15 (07:02-07:08Z), 8 of 8 runnable checks PASS on every pass - 40 of
40 clean.** Both clients classified on all five, server window clean on six of seven services;
`core-service` carries the open avatar P2 ([backlog](backlog.md)), which is not READ's and is not
silenced.

**STILL VALID ON `1c655cb4`, and that is a measurement, not an assumption.** The close-handshake fix
(`a60599e2`) landed on the unload path AFTER this run and was reverted the same day, so the surface
READ measures went out and came back: `git diff f823496a..1c655cb4 -- frontend/src` is a comment, a
test, and `const sendDisconnectOnUnload = () => x()` rewritten as an inline arrow - same function,
same listener, same `{ once: true }`. A phase re-runs when a commit touches the surface it measures;
a comment does not touch it. **Name the build in the row, and the question answers itself** - these
rows did not, until this one.

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| READ-1 | Reading on W1 clears the unread badge on W1 and marks it read for the sender | `W1 W2` | `PASS` 5/5 - clears 3-11 ms, read 1-4 ms |
| READ-2 | The SAME user's other device also clears - a receipt from yourself resets your own count | `+A1` | `PASS` 5/5 - A1 clears in ~2.2 s, untouched |
| READ-3 | The receipt only fires with the window FOCUSED and the tab visible: a background tab must not mark read | `W1 W2` | `PASS` 5/5 - silent 6 s hidden, ~2.1 s once restored |
| READ-4 | The 2 s debounce batches: reading twenty messages sends ONE watermark, not twenty receipts | `W1 W2` | `PASS` 5/5 - 20 markers, one flip in 2-8 ms |
| READ-5 | "Seen by" resolves to display names, and to `+N` past three | `W1 W2` | `SKIPPED` - `+N` needs a 4th reader, the campaign has 2 accounts |
| READ-6 | Channels send no receipts at all, by design - and their read state comes from the server tally | `W1 W2` | `PASS` 5/5 - no receipt in a 4 s window, no exception |
| READ-7 | Unread count after a reload, with the receipt still in flight | `W1 W2` | `PASS` 5/5 - clears, no duplicate |
| READ-8 | Unread count on a conversation whose messages arrived while logged out | `W1 W2` | `PASS` 5/5 - 3 of 3 counted, ~215 ms after reconnect |
| READ-9 | Read on A1 while W1 is open: the count on W1 goes without a reload | `+A1` | `PASS` 5/5 - W1 clears live in ~2.1 s |
| READ-10 | Reading a conversation whose peer has deleted it | `W1 W2` | `SKIPPED` - `--destructive` only; creates debris the cleanup must know about |

## 4 - MUT - editing, deleting, reacting, pinning

The four things a user does to a message that already exists. All four are MLS system events in a DM
or a group and REST calls in a channel, so **every row whose cell says both runs twice**, once in the
owner-peer DM and once in `Campagne de test`, with the two results recorded separately.

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| MUT-1 | **DM.** Edit a text message: both sides show the new text and an edited marker | `W1 W2` | `pending` |
| MUT-2 | **DM.** Edit clears `readBy` - the receipt restarts, and the sender's "read" indicator goes back | `W1 W2` | `pending` |
| MUT-3 | **DM.** Edit is refused on a message with media, and on someone else's message | `W1 W2` | `pending` |
| MUT-4 | **DM.** Edit a message the peer has NOT yet received: peer must end up with the edited text, once | `W1 W2` | `pending` |
| MUT-5 | **Channel.** Edit is absent by design - assert the control is not offered | `W1 W2` | `pending` |
| MUT-6 | **DM.** Delete a message: both sides show the tombstone, not a gap | `W1 W2` | `pending` |
| MUT-7 | **DM.** The tombstone WINS over a body on merge - a device holding the original must not resurrect it | `W1 W2` | `pending` |
| MUT-8 | **Channel.** Delete is a HARD row delete, no tombstone: assert the difference is real | `W1 W2` | `pending` |
| MUT-9 | **Channel.** A moderator deletes another user's message | `W1 W2` | `pending` |
| MUT-10 | **DM.** The toolbar offers Delete to a moderator, where the handler refuses it | `W1 W2` | `pending` - a suspected defect, see the negatives |
| MUT-11 | **Both.** React, un-react, re-react; two users on the same message; the same user with several emoji | `W1 W2` | `pending` |
| MUT-12 | **Both.** The 15-distinct-emoji cap, on both transports | `W1 W2` | `pending` |
| MUT-13 | **DM.** A reaction pushes a notification to the message author only, never to the reactor | `+push` | `pending` |
| MUT-14 | **Both.** Pin and unpin, seen on the OTHER device | `+A1` | `pending` |
| MUT-15 | **DM.** A pin does not survive on a fresh device - localStorage-only, no history replay | `+A1` | `pending` - expected to fail; it is a real hole |
| MUT-16 | **Channel.** A pin DOES survive, because it is re-hydrated from the server | `+A1` | `pending` |
| MUT-17 | **DM.** Edit, then delete, then react to the deleted message | `W1 W2` | `pending` - the absurd crossing |
| MUT-18 | **DM.** Two devices of the SAME user edit the same message at once | `+A1` | `pending` |
| MUT-19 | **DM.** Delete a message that is still in the outbox, unsent | `W1 W2` | `pending` |
| MUT-20 | **DM.** Mutate a message older than the 90-day server retention window | `W1 W2` | `pending` |

## 5 - SEARCH - finding a message

Search is client-side, in-conversation, substring-only. There is no server index and no global
search, so the phase measures what the local store actually holds - which makes it a second,
independent probe of the same loss class `recon.mjs` measures, and it needs the edited and deleted
messages rung 4 produced.

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| SEARCH-1 | A term in a recent message is found and highlighted, prev/next walk the hits | `W1 W2` | `pending` |
| SEARCH-2 | A term only in OLD history: does the `searchLimitedToLoaded` flag tell the truth? | `W1 W2` | `pending` |
| SEARCH-3 | Deleted messages are excluded; edited messages match their NEW text, not the old | `W1 W2` | `pending` |
| SEARCH-4 | Channel search pulls up to 2000 rows and decrypts them - time it, and watch for a stall | `W1 W2` | `pending` |
| SEARCH-5 | Accents and case: a French corpus is the real corpus here | `W1 W2` | `pending` |
| SEARCH-6 | The sidebar filter is a DIFFERENT search (name + last message) - assert it does not claim more | `W1 W2` | `pending` |

## 6 - MENTION - mentions and what they trigger

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| MENTION-1 | The autocomplete inserts the `@[uuid]` token, and it renders as a chip linking to the profile | `W1 W2` | `pending` |
| MENTION-2 | In a CHANNEL, the mentioned user gets a push even at level `mentions` | `+push` | `pending` |
| MENTION-3 | At level `none`, the mention gets nothing | `+push` | `pending` |
| MENTION-4 | In a DM or group a mention triggers NOTHING extra - assert it, do not assume it | `W1 W2` | `pending` |
| MENTION-5 | Mention a user who is not a member of the channel | `W1 W2` | `pending` |
| MENTION-6 | The channel path sends `mentionedUserIds` in CLEARTEXT - confirm the leak is the documented one and nothing more | `W1 W2` | `pending` |

## 7 - FWD - forwarding

One message crossing from the channel world into the MLS world - the first composite in the ladder,
and the phase that found the campaign's central defect (a reload rewinds the sender's
ratchet and the receiver silently drops the next message).

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| FWD-1 | Channel -> DM forward, the exact shape of the reported prod loss | `W1 W2` | `passed` 5/5 |
| FWD-2 | The same, 25 times in a loop - any single miss is the bug | `W1 W2` | `passed` - 25/25 delivered, 0 lost, 0 duplicated, both sides clean on every iteration, arrival 125-234 ms (median 149) |
| FWD-3 | Forward while the sender goes offline mid-send | `W1 W2` | `passed` 5/5 |
| FWD-4 | Forward from A1, backgrounded 200 ms later | `+A1` | `passed` 5/5 |
| FWD-5 | Forward into a conversation not opened this session | `W1 W2` | `passed` 5/5 - its root cause was the reload, not the forward |

**FWD is closed: five passes, every runnable check `PASS` on every one, every server window clean**
(2026-08-15, run on the migrated rig). FWD-2 is not in the manifest - it is volume, not a phase step -
so it is run by hand: `node fwd.mjs 25`.

Two things the run says that a bare verdict does not:

- **The phase only became reproducible once the CLICK could name what received it.** Before that,
  `clickBubbleAction` computed its own coordinates and therefore grew its own dispatch, inheriting no
  hit-test, no recorder and no parking - it clicked blind, and a miss surfaced ~15 s later as a
  missing dialog, indistinguishable from an application defect. The run before the fix was 4 passes
  of 5; the failing one now names its own cause at the click instead
  (`"Transférer" action moved before the click: nothing clickable at the point`). See
  [testing-methodology](testing-methodology.md).
- **8 of FWD-2's 25 iterations log a `SecretReuseError` on the SENDER, and every one is expected.**
  The sender receives its own forwarded frame back, the archive replay has already read it, so the
  ratchet secret is spent. The line names itself - `Duplicate delivery … silent ACK (SecretReuseError,
  already read by the archive replay)` - which is exactly what the false-loss fix was for: recognised
  and acknowledged, never counted as a loss. `receiverClean` is true on all 25.

## 8 - GRP - group membership and invitations

The first rung that moves an MLS epoch. Split out of DEL once the DEL-1 rig found a defect in a
control nobody had ever asserted on.

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| GRP-1 | Create a group, add a member, both sides see the roster and the Add commit merges | `W1 W2` | `pending` |
| GRP-2 | The member picker must not offer users who are ALREADY members, yourself included, and a submission that can do nothing must not report success | `W1 W2` | `pending` |
| GRP-3 | Remove a member: the Remove commit, and what the removed device can still read | `W1 W2` | `pending` |
| GRP-4 | The group invitation LINK: generate, open it on the other account | `W1 W2` | `pending` |
| GRP-5 | Rename a group, seen on the other side | `W1 W2` | `pending` |
| GRP-6 | Leave a group - which deliberately commits nothing | `W1 W2` | `pending` |
| GRP-7 | Add a member who is offline; they join on their next connection | `W1 W2` | `pending` |
| GRP-8 | Add and remove the same member twice in a row, fast | `W1 W2` | `pending` |
| GRP-9 | A member row rendering a raw user id instead of a display name | `W1 W2` | `pending` - observed once, same class as the `Utilisateur inconnu` fixes |

## 9 - COMM - communities, channels, roles

A community is a `Workspace`, and **its membership is not MLS membership**. A kick rotates a
server-held epoch key; it commits nothing. Every row here must be read against MSG-5's standing
assertion: **no `masterSecret` in any payload, ever**.

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| COMM-1 | Create a community, create a channel, post, both peers converge | `W1 W2` | `pending` |
| COMM-2 | Invite link: create, preview, accept from the other account | `W1 W2` | `pending` |
| COMM-3 | An expired link, a `maxUses`-exhausted link, and a link to a deleted community | `W1 W2` | `pending` |
| COMM-4 | Direct invite: the `channel_invitation` card appears in the 1:1 DM on both sides, deduped | `W1 W2` | `pending` |
| COMM-5 | Roles: promote to moderator, then admin; the permission grid takes effect immediately | `W1 W2` | `pending` |
| COMM-6 | A custom role with a hand-picked permission set | `W1 W2` | `pending` |
| COMM-7 | `writePolicy` = admins only: the composer is refused for a member, server-side as well as in the UI | `W1 W2` | `pending` |
| COMM-8 | Private channel: a non-allowed member cannot see it - **and cannot fetch it by id either** | `W1 W2` | `pending` |
| COMM-9 | Kick from a channel: the key rotates, and the kicked device can no longer decrypt NEW messages | `W1 W2` | `pending` |
| COMM-10 | Kick from a channel: the kicked device can still decrypt the OLD ones it already holds | `W1 W2` | `pending` |
| COMM-11 | Kick from the COMMUNITY, which carries no channel id: the client purges the whole workspace | `W1 W2` | `pending` |
| COMM-12 | Re-invite a kicked user: they get the new epoch and not the old one | `W1 W2` | `pending` |
| COMM-13 | Manual key rotation with both sides online, and with one side offline | `W1 W2` | `pending` |
| COMM-14 | Channel notification levels `all` / `mentions` / `none`, enforced server-side | `+push` | `pending` |
| COMM-15 | Polls: create, vote, close; auto-pinned | `W1 W2` | `pending` |
| COMM-16 | Delete a channel, then a community; the client drops them and the slug stays reserved | `W1 W2` | `pending` |
| COMM-17 | Reorder communities by drag and drop; the order survives a reload and reaches the other device | `+A1` | `pending` |
| COMM-18 | Deep link into a channel from a cold start | `+A1` | `pending` |
| COMM-19 | The last admin leaves a community | `W1 W2` | `pending` - the absurd one, and nothing in the inventory says what happens |
| COMM-20 | Two admins change the same role at the same moment | `W1 W2` | `pending` |
| COMM-21 | A member is kicked while composing a message in that channel | `W1 W2` | `pending` |
| COMM-22 | `hydrateChannelHistoryKeys` on a channel with many epochs - time it | `W1 W2` | `pending` |

## 10 - DEL - deleting a conversation, crossed

Deletion had never been a subject, only a step - every phase deletes groups as setup or teardown, and
nothing ever asked what deletion CROSSES. What makes a crossing worth a row: deletion is one of the
few operations that removes state while OTHER state keeps pointing at it. So each row pairs it with
something mid-flight, which is why it sits above tiers A-C rather than inside them.

| Id | The crossing | Needs | State |
| --- | --- | --- | --- |
| DEL-1 | Peer deletes while a history solicitation for that group is outstanding | `W1 W2` | `pending` - no banner, no marker and no retried solicitation may survive on the removed row |
| DEL-2 | Peer deletes while a message from us is in the outbox | `W1 W2` | `pending` - the entry resolves or fails LOUDLY, never a silent permanent pending |
| DEL-3 | Both peers delete the same conversation within a second of each other | `W1 W2` | `pending` - no error either side, neither resurrects it |
| DEL-4 | Delete a conversation while its media is still uploading | `W1 W2` | `pending` - no orphan blob left addressable |
| DEL-5 | Delete, then the peer sends into it anyway | `W1 W2` | `pending` - dropped without a decrypt-failure marker; a deleted group must not look like a loss |
| DEL-6 | Delete while a drain is in flight for that group | `W1 W2` | `pending` - `Drain start` must still get its `Drain complete` |
| DEL-7 | Delete on W1 while A1 is killed, then wake A1 | `+push` | `pending` - A1 converges to deleted, and must not re-create the row from a queued frame |
| DEL-8 | Delete a group, then restore an MLS snapshot from BEFORE the deletion | `+snapshot` | `pending` - the absurd one: the group returns to WASM while the server has none, and must be purged as an orphan rather than left soliciting for ever |
| DEL-9 | Delete the conversation currently OPEN on screen | `W1 W2` | `pending` - the view leaves cleanly, the composer cannot send into a removed row |
| DEL-10 | Delete while offline, then reconnect | `W1 W2` | `pending` - reaches the server once, and does not re-broadcast on every later reconnect |

Every row is also a place to re-read the three states of a deleted conversation - the durable marker,
the reactive phase, the scheduled burst - because they are exactly the kind of thing cleared on one
path and forgotten on the other nine.

## 11 - TAB - tabs and windows

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| TAB-1 | Backgrounded tab receives; title/badge updates | `W1 W2` | `pending` - largely subsumed by MSG-8/8b |
| TAB-2 | Tab closed, message arrives, tab reopened: present exactly once | `W1 W2` | `pending` |
| TAB-3 | Whole browser killed and relaunched: all arrive, no re-login | `W1 W2` | `pending` |
| TAB-3b | Cold-start timing, five runs | `W1 W2` | `pending` - **one unexplained run stands on the record**: 77.7 s to render with everything ready at 6.9 s, not reproduced in four further runs. If it recurs, capture everything between `Drain start` and the decrypt |
| TAB-4 | Two tabs of the SAME account: no double-send, no epoch fight | `W1 W2` | `pending` |
| TAB-5 | Reload fired under 100 ms after submit: sent once or clearly queued, never lost | `W1 W2` | `pending` |
| TAB-6 | Delete the refresh cookie, then act: clean re-login, not a silent empty list | `+user` | `pending` - the re-login costs the 2FA, so it batches to the end |
| TAB-7 | Offline -> act -> online, tab never reloaded | `W1 W2` | `pending` |

## 12 - MULTI - one user, two devices

This rung opens by sweeping every `+A1` row left behind in tiers B and C.

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| MULTI-1 | Send from W1: appears on A1 as an OWN message | `+A1` | `pending` |
| MULTI-2 | Read on A1: read state reflected on W1 | `+A1` | `pending` - known backlog item; record actual behaviour |
| MULTI-3 | A1 enrolled AFTER W1 has history | `+A1` | `pending` - record exactly what arrives |
| MULTI-4 | Revoke A1 from W1, then A1 acts (= device check L) | `+A1` | `pending` |
| MULTI-5 | W1 + A1 + a second W1 tab on one channel | `+A1` | `pending` - no epoch conflict, no `SecretReuse` |
| MULTI-6 | A1 offline a long while, 20 messages, then returns | `+A1` | `pending` |

## 13 - LIFE - Android lifecycle

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| LIFE-1 | Foreground baseline | `+A1` | `pending` |
| LIFE-2 | Background (`HOME`): notification carries the real decrypted text | `+push` | `pending` |
| LIFE-3 | Killed - **swipe from recents, not `am force-stop`** | `+push` | `pending`. Force-stop is worth running but answers a different question: Android's STOPPED state cancels every FCM broadcast until a manual launch |
| LIFE-4 | Doze (`dumpsys deviceidle force-idle`) | `+push` | `pending` |
| LIFE-5 | After a reboot, app never opened - exercises `CanariBootReceiver` | `+push` `+user` | `pending` - needs the unlock pattern, which `wm dismiss-keyguard` cannot answer |
| LIFE-6 | Offline (both radios) | `+A1` | `pending` |
| LIFE-7 | Notification permission revoked mid-life | `+push` | `pending` |
| LIFE-8 | Process death (`am kill`), keeping WorkManager state | `+push` | `pending` |

Cross every LIFE state with: receive a DM, a channel message, a commit, a call. That matrix is the
point of the phase.

## 14 - NOTIF - notifications

This rung sweeps every `+push` row left behind above it.

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| NOTIF-1 | App killed, DM arrives: decrypted notification with real content | `+push` | `pending` - LIFE-8's assertion, recorded here too |
| NOTIF-2 | App killed, a **commit** pushed, then a message | `+push` | `pending` - the epoch gap. Background decrypt applies no commit, so a generic fallback is CORRECT; what must hold is that opening the app recovers |
| NOTIF-3 | The same, message several epochs later | `+push` | `pending` |
| NOTIF-4 | Read on W1 while A1 is killed: notification dismissed on A1 | `+push` | `pending` |
| NOTIF-5 | Per-channel level muted on W1: A1 does not notify, message still arrives | `+push` | `pending` |
| NOTIF-6 | Quick reply from the shade (= device check K) | `+push` | `pending` |
| NOTIF-7 | Tap -> deep link into the conversation, **backgrounded** | `+push` | `pending` |
| NOTIF-7b | The same with the app **KILLED** | `+push` | `pending` |
| NOTIF-8 | Doze + message: delivered, or on wake - record which | `+push` | `pending` - LIFE-4's assertion |
| NOTIF-9 | Two devices of one user: exactly one notification surface behaves | `+push` | `pending` |
| NOTIF-10 | Airplane mode 10 min, 5 messages, then reconnect | `+push` | `pending` - all five must survive; the SHADE collapsing them is an OS behaviour, not a loss |

## 15 - CALL - audio and video

**The largest hole in the campaign.** Calls have four unit-test files, zero harness scripts, zero
`test_adb.py` coverage - and they are the feature with the most moving parts: an SFU, a TURN
provider, a 5-minute room token, MLS-exported media keys, insertable streams, CallKit on one platform
and a full-screen intent on the other. That is precisely why the rung is last before the destructive
tier: a call failure attributable to any of tiers A-D would be a day of discrimination.

Media is encrypted with a key exported from MLS (`exportSecret(groupId, 'mls-webrtc-media', callId,
32)`) and applied per encoded frame. **If the browser does not support the transform, the call
silently degrades to SFU-visible DTLS-SRTP** and a store flips to false. Asserting that store is part
of every call check, not a separate one.

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| CALL-1 | 1:1 audio W1 -> W2: ring, accept, two-way audio, hangup on either side | `W1 W2` | `pending` |
| CALL-2 | 1:1 video: both streams render, and the E2E transform is ACTIVE - not the degraded path | `W1 W2` | `pending` |
| CALL-3 | Group call in a 3-member group, one leg on A1 | `+A1` | `pending` |
| CALL-4 | Decline: the callee stops ringing - and the caller learns nothing, which is the current design | `W1 W2` | `pending` |
| CALL-5 | Cancel before answer: `ring-end` reaches every device including the caller's siblings | `+A1` | `pending` |
| CALL-6 | Answer on A1 while W1 is also logged in: W1 stops ringing (sibling suppression) | `+A1` | `pending` |
| CALL-7 | Unanswered: 60 s native timeout fires on the phone; the WEB side has no timeout at all | `+A1` | `pending` |
| CALL-8 | Toggle mute, toggle camera mid-call, and camera-on from an audio-only start (renegotiation) | `W1 W2` | `pending` |
| CALL-9 | Speaker/earpiece routing on A1 | `+A1` | `pending` |
| CALL-10 | Incoming call with the app KILLED: FCM high-priority wakes it, full-screen intent, deep link answers into the right conversation | `+push` | `pending` |
| CALL-11 | The same in forced Doze | `+push` | `pending` |
| CALL-12 | Incoming call on the LOCK SCREEN, answered without unlocking - then what the PIN gate does | `+push` `+user` | `pending` |
| CALL-13 | iOS CallKit end to end: VoIP push, native UI, answer, `pending_call_accept.json`, auto-accept | `+user` | `pending` - **never run on hardware** |
| CALL-14 | A call is refused in a community channel, by design | `W1 W2` | `pending` |
| CALL-15 | The room token expires (5 min): start a call, hold the invite, accept late | `W1 W2` | `pending` |
| CALL-16 | Network drop mid-call - **expected to end the call**, there is no ICE restart. Confirm the UI says so | `W1 W2` | `pending` |
| CALL-17 | A second incoming call while already in one - **expected to vanish silently**. Confirm, then decide | `W1 W2` | `pending` |
| CALL-18 | The missed-call system message: who it names and on whose device | `W1 W2` | `pending` - a suspected defect, see the negatives |
| CALL-19 | Call system messages survive a reload and appear on a second device | `+A1` | `pending` |
| CALL-20 | Start a call, then the peer deletes the conversation | `W1 W2` | `pending` - crosses DEL |

## 16 - HEAL - does a broken group repair itself?

Everything the queue and drain work proved was proved **on the phone**. The fixes are shared
TypeScript, but "the same code" is an argument, not a measurement, and the two clients do not break
the same way: the web MLS state is IndexedDB rather than `mls.bin`, the recovery runs against a live
WebSocket instead of a cold reconnect, and only the browser has a second tab that can hold the leader
role while the broken one recovers.

The break is made by **restoring an older snapshot** of the web MLS database over the current one -
exactly the rewind this campaign chased, done deliberately. It rewinds W1's ratchet in EVERY group it
holds, which is why no rung may follow it without a teardown.

| Id | How the group is broken | Needs | State |
| --- | --- | --- | --- |
| HEAL-W1 | Restore a snapshot from BEFORE a membership commit, then have the peer send | `+snapshot` | `pending` - epoch gap. A `healed` verdict after applying ZERO commits is a regression |
| HEAL-W2 | Restore from BEFORE the group was joined at all | `+snapshot` | `pending` - see below; its verdict was rewritten and the old form could not pass |
| HEAL-W3 | Freeze one client while the peer advances its ratchet past 2 000 frames in one epoch | `+snapshot` | `pending` - generation gap. `TooDistantInTheFuture` must beat `GAP_QUEUED`, as it does on Android. The expensive one: a scripted volume run |
| HEAL-W4 | HEAL-W2 with a SECOND tab holding the leader role | `+snapshot` | `pending` - **no prior art on either client**: the multi-tab seam meeting the recovery seam |
| HEAL-repair | Does the history diff repair a rewound sender end to end? | `+snapshot` | `pending` - and the assertion is now quantitative: how much traffic did the repair cost? The deleted mechanism ran at ~450 frames/min for ten minutes while repairing nothing, so a run whose frame rate does not fall back to the ordinary send rate has found something |

Every run of a HEAL check needs, without exception: `reload.mjs` **first** (both browsers on the
current bundle); a record of **which device answered**, since the responder is elected; and a
teardown that restores the **invariant**, never a snapshot.

## 17 - PIN

Read [auth](frontend/modules/auth.md) before running any of these - the PIN, the device key vault and
`mls.bin` are one mechanism. It sits here because PIN-3 probes the lockout rule, and a lockout blocks
everything downstream.

| Id | What it asks | Needs | State |
| --- | --- | --- | --- |
| PIN-1 | Correct PIN, online | `W1 W2` | `pending` |
| PIN-2 | Wrong PIN xN: rejected, no lockout a correct PIN cannot clear, `mls.bin` untouched | `W1 W2` | `pending` |
| PIN-3 | A short PIN at setup, change, recovery AND unlock - the same rule in all four | `W1 W2` | `pending` - the documented lockout trap |
| PIN-4 | Change the PIN on W1: key re-wrapped, other clients unaffected | `W1 W2` | `pending` |
| PIN-5 | Change it on A1 while W1 is open | `+A1` | `pending` |
| PIN-6 | Remove the PIN: the at-rest key survives the transition | `W1 W2` | `pending` |
| PIN-7 | PIN unlock while OFFLINE | `W1 W2` | `pending` - **a clean refusal is the expected result**. Offline unlock is biometrics/vault only; widening it to the PIN is a security change wearing a UX hat |
| PIN-8 | Server unreachable but `navigator.onLine === true` (captive-portal shape) | `W1 W2` | `pending` - a transport failure must NOT log the user out; only a 401/403 may |
| PIN-9 | "Stay signed in", browser closed and reopened: vault path, no server round trip | `W1 W2` | `pending` |
| PIN-10 | Correct PIN, corrupt vault blob | `+snapshot` | `pending` - explicit failure, never a silent wrong-key state |

## 18 - CORRUPT - deliberate store damage

**Runs last.** It destroys state, and SETUP-8's archive is the only way back that does not cost a
full re-enrolment.

| Id | Corruption | Needs | State |
| --- | --- | --- | --- |
| CORRUPT-1 | Truncate the MLS state to half its length | `+snapshot` | `pending` - explicit failure + recovery, never a silent empty history |
| CORRUPT-2 | Flip one byte inside the ciphertext | `+snapshot` | `pending` - the AEAD tag must fail; detected as tampering |
| CORRUPT-3 | Web vault blob replaced with valid base64 of garbage | `+snapshot` | `pending` - must surface, not hang |
| CORRUPT-4 | Zero-length MLS state | `+snapshot` | `pending` - treated as absent, clean re-enrolment |
| CORRUPT-5 | An MLS state in an OLDER envelope format | `+snapshot` | `pending` - **this is what proves the at-rest compatibility rule**. Keep a copy from before every format change |
| CORRUPT-6 | Delete `push_context.json` while killed, then push | `+push` `+snapshot` | `pending` - recover or fail loudly, never a decrypt loop |
| CORRUPT-7 | Drop an object store from the web message store mid-session | `+snapshot` | `pending` |
| CORRUPT-8 | A wrong-user MLS state restored under another account | `+snapshot` | `pending` - **security-relevant: a pass that "works" is a finding** |
| CORRUPT-9 | Fill the data dir until writes fail, then receive | `+A1` `+snapshot` | `pending` - no half-written save |
| CORRUPT-10 | Kill the process **during** an MLS state write | `+A1` `+snapshot` | `pending` - never a half-file read as valid |

---

## The instrument

### recon.mjs measures the store, not the screen

Rewritten 2026-08-11. The reconciliation is the campaign's only instrument for the silent-loss class,
and until then it read campaign markers out of the rendered message pane. Every problem that design
had came from one fact: **the pane is a window onto the history, not the history.** It had to scroll;
scrolling pages 50 rows at a time; so it needed a time window to stay honest, a coverage proof, and
about a minute per side. Run against a 1804-message DM, it read **60 rows** and printed
`reconciled: true` - its marker pattern had drifted and matched nothing, it called an empty
difference over an empty set a reconciliation, and its scroll loop assigned `scrollTop` without
dispatching an event, so at the top it assigned 0 to 0 and concluded it had reached the beginning of
history after four steps.

It reads both clients' IndexedDB now. Rows are ciphertext at rest (`iv` + `cipherText`) but `id` and
`conversationId` are plaintext, so the two stores can be compared exactly without decrypting
anything: **1804 = 1804, shared 1804, zero either side, in 0.58 s** against roughly two minutes for a
windowed answer covering 3% of the conversation. It works on a conversation of any size, because it
never looks at a window.

What it cannot say: that a message *decrypted*, only that both clients hold it. Rendering and
decryption are asserted per check, by the marker each one sends.

Four properties worth keeping:

- **Membership comes from the `conversations` store, not from the message rows.** Keyed off messages
  alone, a conversation a client is in but has received *nothing* for has no rows, so it looks like a
  conversation the client is not in - and a total loss, the worst case, would be the one case that
  reconciled silently.
- **A conversation `removed` on either side is expected to diverge**, and is reported apart rather
  than as a difference. That is what deleting it means.
- **`VACUOUS` is a third verdict, not a flag on a boolean**, and it exits non-zero.
- **It REFUSES to read a Tauri client rather than answer wrongly.** A1 carries a `CanariDB_*`
  database that is present, openable, correctly shaped and **permanently empty** - a vestige of the
  shared web code path - while its real store is SQLite behind Tauri. Read through it, a healthy
  phone showing nine conversations reports zero of everything. It never fabricated a `LOSS` (nothing
  is shared, so the verdict was `VACUOUS`), but `VACUOUS` sends the reader to look for a missing
  conversation rather than at the wrong store. It now answers `WRONG STORE`, names the runtime, and
  reports how many conversations the client is showing.

### The other instruments, and what each was wrong about first

> **One-shot probes are not kept.** A diagnosis usually needs a throwaway script written next to the
> rig, and 285 of them had accumulated beside the real checks until nobody could tell an instrument
> from a leftover; they were deleted on 2026-08-15 and `scratch/` is where their successors go. So a
> `.mjs` named in a historical write-up on this wiki - `webstate.mjs`, `unloadframe.mjs`,
> `falseloss*.mjs`, `check-loss-a1.mjs`, `trace-arrival.mjs`, `probe-csp-blob.mjs` - is a probe that
> answered its question and was removed. **The measurement stands; the file is gone**, and every
> write-up states the technique in full for exactly that reason. What survives as an instrument is
> what the manifest reaches, plus the tools the README lists.

- **`reload.mjs`** is the other half of `bundle-id.mjs`: it detects staleness AND repairs it, then
  re-asserts the build id rather than assuming the reload took.
- **`unlock.mjs`** resolves which account owns which port from the `clients` field in
  `test-accounts.json`, navigates to a route where the gate actually MOUNTS, and spawns `pin.mjs` -
  so the recurring "you forgot the PIN" costs one idempotent command, and no real first name has to
  be typed into a shell line.
- **`awaiting.mjs`** was **OBSOLETE as an instrument** and has been deleted with the residue - the
  durable awaiting-history registry it read no longer exists (see
  [history-reconciliation](protocols/history-reconciliation.md#what-disappears)); a re-run would find
  an empty store on every client and report health it cannot observe. Kept here only for the two
  faults it taught, both of which apply to any probe: it looked for the evidence in a `_reason`
  companion key when the registry stored `{since, reason}` as the JSON *value*, so it reported every
  marker on every client as legacy - a unanimous answer contradicting a measurement taken the day
  before, which is what a vacuous probe always looks like. And it returned `[]` rather than `null`
  when it could not read a store, which is "a failed read is not an empty store" broken inside the
  instrument that exists to enforce it. **What replaces it** for the reworked build is a probe of the
  reconciliation's in-memory notes, which no longer survive a reload - so the observable is now the
  LOG line (`[HISTORY_RECONCILE] … group(s) asked`), not a stored key.
- **The group fixture is now `newgroup.mjs` + `invite.mjs`** (create, then add a member and prove the
  roster moved), shared by the DEL, GRP and HEAL rigs. They replace the single `testgroup.mjs`
  because the two halves are needed apart: creating a group is what HEAL-W2 needs, while the ADD is
  separately the campaign's only cheap, deterministic epoch generator.
- **Continuous sampling replaces any two-sample arrival check**, and it is now a property of the
  checks themselves rather than of a standalone probe: `watch.mjs` observes throughout, and a check
  that measures an arrival samples the receiver rather than looking twice. The probe that first
  established this (`trace-arrival.mjs`) was a one-shot and is gone; its measurements stand where
  they are written up.

## The negative rows - what does NOT exist

Written down so that no check is invented for them, and so that nobody "fixes" one by reflex during a
run. Each was confirmed absent in the code on 2026-08-11, not merely unremembered.

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

**And four doc-rot items are owed**, all cheap, none a defect in the product:
`docs/wiki/protocols/websocket-protocol.md` documents a `WsEnvelope` / `ReadAck` protobuf path that
no Rust code references; `docs/wiki/frontend/modules/calls.md` names call states `outgoing`/`active`
where the code says `calling`/`incall`, and lists four call components where there is one;
`docs/wiki/services/chat-delivery.md` still carries `LIVEKIT_*` environment variables and calls the
room token a "LiveKit room token" when the SFU is the in-repo Rust `call-service`; and the TURN TTL
is documented at 3600 s and coded at 7200.

## The at-rest artefacts

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
missing. Any check that reaches for a web artefact must enumerate `indexedDB.databases()` and match,
never construct a name.

| Client | Artefact | Path / key |
| --- | --- | --- |
| Web | MLS state | IndexedDB `CanariDBMls_<userId>` v1, store `state` |
| Web | message store | IndexedDB `CanariDB_<userId>` v6: `conversations`, `messages`, `outbox` |
| Web | device key vault | `sessionStorage.canari_device_key_vault` + `canari_device_key_vault_key` |
| Web | vault persistence flag | `localStorage.canari_device_key_persist` |
| Web | device id, last active, saved user | `localStorage.mls_device_id_<userId>`, `canari_last_active:<userId>`, `canari_saved_user` |
| Web | WS auth | cookie `canari_ws_token` - the only cookie readable from JS |
| Android | MLS state | `mls.bin`, at the app data **ROOT**, not under `files/`. ChaCha20-Poly1305, `[nonce 12 \|\| ct]`, **no version field** |
| Android | message store | `canari_<dev>.db` + `-wal` + `-shm`. **WAL mode, and the WAL is where the data is** - corrupting the `.db` alone tests nothing |
| Android | pending MLS, channel keys, push context | `mls_pending.db`, `channel_keys.json`, `push_context.json` |
| Android | device key | `shared_prefs/keystore_aliases.xml`, `<alias>_ct` / `_iv` |
| Android | push secret, native flags, app log | `pending_push_secret.txt`, `fcm_token.txt`, `native_flags.json`, `logs/Canari.log` |
| Android | WorkManager | `no_backup/androidx.work.workdb*` |

`run-as` reaches all of it **only because the installed build is debuggable**; a release build refuses
outright. Worth recording what is NOT there: **no access token in any web storage**, on either client
- the "access tokens in memory ONLY" rule holding in production.

---

## A commit from another contributor owes a WEB pass and a MOBILE pass

Their tests establish that their code compiles and that their units behave. They cannot establish
that it RUNS against this deployment, which is the only thing this campaign is for. So each of their
commits that lands in a measured surface gets two observations, and they are not the same observation
twice: a panel can render perfectly in a browser and be empty on a phone, because the two halves are
fed by different code.

The device-storage panels are the worked example: the WEB pass is the only one that can see an admin
panel reading four independent backend measurements, one of them across a service boundary - the
exact shape that fails only on a deployment, silently, when a variable is missing from a compose
`environment:` block; the MOBILE pass is the only one that can see a NEW Rust command
(`get_local_storage_usage`) that the web build never calls, and a Tauri v2 command not granted in
`capabilities/` builds, ships, installs and then rejects on a real device.

Three things that pass taught, and they generalise to every future one:

- **Assert on what the PAGE rendered, not on a probe of your own.** The first web attempt called the
  admin endpoint with a bare `fetch` and got `403 Operation restricted to global admins` while the
  page beside it showed all four figures - because the access token lives in MEMORY, never in a
  cookie. The 403 was the right answer to the wrong question, and reporting it would have accused the
  app of the harness's mistake.
- **Scope a log filter to the app's own pid.** `logcat -b all` carries the whole platform: an
  unscoped search for `forbidden` counted 26 "command rejections" that were the modem printing
  `Received Forbidden PLMNs`. That verdict would have blamed a colleague's panel for the phone's SIM.
- **Prove WHICH bundle is running, or the run measures the previous one.** An install can succeed over
  a WebView that then serves a cached page. The check compares the loaded `_app/immutable/entry/*.js`
  names against the local build output - and it must read
  `performance.getEntriesByType('resource')`, not `script[src]`: SvelteKit boots from an inline
  module, so a selector-based version of this assertion finds nothing and silently asserts nothing.

## The campaign owns its own debris, and clearing it is a check in itself

A campaign that creates groups, devices and backlogs on the PRODUCTION database leaves state behind
that later runs then measure - and cannot tell from real traffic. Clearing it is the last step of the
ladder, after CORRUPT's rollback.

**Delete test groups through the UI, never by SQL.** `DELETE /api/mls/groups/:groupId` emits nothing
to clients: the notice is an E2EE MLS `groupDeleted` system message the CLIENT sends *before* calling
the server, precisely because the server call hard-deletes `dm_group_members` and strips the routing
a later message would need ([groupActions.ts:98](../../frontend/src/lib/utils/chat/groupActions.ts)).
An `UPDATE` straight into Postgres leaves the peer holding a live MLS group for a conversation that
no longer exists - manufacturing the exact orphan state this campaign hunts. Going through the UI
also exercises `deleteGroupAndBroadcast`, which no check covers.

**Revoke a dead client generation, do not delete its rows.** One dead browser generation held 2 073 of
the platform's 2 916 queued rows; see
[chat-delivery > the answer was a REVOCATION](services/chat-delivery.md) for why deleting the rows
would have been the wrong shape.

Two rules for any destructive cleanup script, both learnt by nearly getting them wrong:

- **Name the target, never infer it.** The device dialog labels its rows "Appareil 1/2/3" and shows no
  id, so pressing on an ordinal is a guess between this browser, the phone and the debris - and a
  wrong guess destroys a live device's access. The id is in a `title` attribute; the script matches on
  it and **fails** if it does not find exactly one match, rather than falling back to a position.
- **Assert the post-condition, not the click.** The delete is asynchronous (MLS broadcast, then the
  server call), so a loop counting clicks reports success for a no-op. Poll until the entry actually
  leaves the sidebar.

A cleanup script must also only ever match the harness's own name prefixes: a real user's group sits
in the same sidebar.
