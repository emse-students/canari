# Device verification runbook

Everything native in Canari is verified by **compiling**, which proves nothing about running. A
manual `workflow_dispatch` of either release workflow is the only way to compile Swift/ObjC/Kotlin
from a Windows machine, so that is what the mobile work has been gated on - and it is why several
Work Packages sit open with correct-looking code that has never executed on hardware.

This file is the single ordered pass that closes them.

**Its sibling is [cross-client-testing](cross-client-testing.md).** This page asks "does this native
path work on hardware at all?" - one device, one check. That one asks "does the system stay correct
when several clients, several lifecycles and a damaged store meet?" - two browsers and a phone at
once. Checks H, K, L and M below are re-exercised there, in context, rather than in isolation.

**It is the only place they are tracked.** On 2026-08-04 every Work Package whose sole remaining
debt was "run this on a device" was deleted from `CLAUDE.md` and folded in here - a check owed is
not a work package, it is a line in this table. The WP ids are kept in the table because commits and
`CHANGELOG.md` name them. **A check that FAILS earns a new WP; a check that passes earns a PASS
here and nothing else.**

**The bench is the Mi 9T and the iPhone 12. The Pixel 6a is the user's personal phone: observation only** (user, 2026-10-11) - no agent installs, resets, signs in over or drives it; a reading on it is the user's own look.

## Where the pass stands

**2026-10-22, the background Welcome read on the Mi 9T (debug build, frontend `2547870a7`, from `dabc36813` plus an uncommitted manifest whitespace change; local estate with chat-delivery from `4f31a81ad` and the frontend of `5fa025d87`).** The phone was killed (no process), one `mls_group_info` row was deleted, and a new web device of another member asked for a Welcome. Phone: `Welcome created ... baseEpoch=1`, `HTTP 201`, `Welcome sent`, no `sendWelcomeAndCommit failed`. Server: `[BG_WELCOME] START ... baseEpoch=1`, then `REJECT commit epoch_mismatch (server epoch: 3, sent base: 1)`, so there is no `commit accepted`. The commit-caller checks did not refuse. The stale base and the 201 are in [backlog](backlog.md#p2---a-killed-phone-answers-a-background-welcome-from-a-stale-epoch-and-the-route-reports-it-as-sent-read-on-the-mi-9t-2026-10-22). Not read: the newcomer afterwards.

**2026-10-13, the bench pass of the owed rows: Mi 9T on `v1.2.6-alpha.1`, iPhone 12 on `1.2.3-alpha.5` (the newest pre-release TestFlight serves it).** `PASS`: check V, check W on the Mi 9T, the "Rester connecte" cold path and its landing preview, #1603 both halves, #1605 on Android, #1548 and the send path on the iPhone. `FAIL`: Android at 200 % text (two P3 in the agenda) and, met in three-button mode, ONE system Back closing both the message action sheet and the conversation (P2). Answered in part: #1604. Detail: [the bench readings of 2026-10-13](#the-bench-readings-of-2026-10-13---the-owed-rows-a-bench-phone-can-settle).

**2026-10-11, `v1.2.3-alpha.5` on the iPhone 12 (iOS 27.0.1, TestFlight build 100200305, `dev.canari-emse.fr`, account `canari-test-gamma`).** `PASS`: the login page's "Ouvrir dans l'application" opens the app (#1605, iPhone half), the conversation's glass chrome (alignment, "+" > Photos opens ONE picker, the four accessible names), the camera opening full-bleed on the front lens 15 of 15 times with a home-and-return (#1370, front half), the emoji pictures in the composer and the bubble (rows 3 and 12, in part), the profile hub's breadcrumb, a 5 s video sent, the associations list scroll. **`FAIL` in a new shape: check W on the iPhone** (3 of 3 rises). Every reading, what is blocked and what waits for the next pre-release: [the inventory below](#the-iphone-12-owed-readings-inventory-2026-10-11).

**2026-10-07, `v1.0.4-alpha.5` on the iPhone 12 (iOS 27.0.1, TestFlight build 100000405, `dev.canari-emse.fr`).** Read and `PASS`: the signed calendar subscription for the reader's own campus and formation, copied and opened in Calendar (#1541, #1551), the reel camera opening on the FRONT lens (#1552), the post composer draft per account (#1549), the glass tab bar, the profile page, the tab swipe and the reel review controls. **Not read: the reaction toast, the send path and the reply context (#1548)** - `canari-test-gamma` is the service account and cannot discover or be discovered by a non-admin peer. Detail and owed causes: [backlog](backlog.md).

**2026-10-06, `v1.0.4-alpha.4` on the iPhone 12 (iOS 27.0.1, the TestFlight build, `dev.canari-emse.fr`).** Read and `PASS`: the profile page and header (#1513), the glass tab bar, the tab swipe showing its destination and a drift staying put (#1515), the reel review letterbox with its controls, Next to publish and the confirmed discard (#1539, #1505, #1506), Noto emoji, the feed scroll. `FAIL`: the signed calendar subscription refuses the reader's own campus (#1541). Not reached: the reaction toast, the send path and the scheduled-post time (no second account on dev). Detail and owed causes: [backlog](backlog.md).

**2026-10-06, `v1.0.4-alpha.3` on the Mi 9T (a debug build of the same tree on the LOCAL estate - the harness accounts exist nowhere else; the release APK is signed with another key and cannot replace the debug app without an uninstall that costs the device).** Read and `PASS`: the tab swipe with no leftover shift (#1515), the profile header (#1513), conversation order across both accounts (#1510), the top-placed reaction-failure toast (#1509), the reel editor end to end (#1504-#1506), the own-message reply swipe icon, #1287, #1288, D1 and D4. **FAIL or owed, with the evidence on [device-readings-2026-10](device-readings-2026-10.md)**: no haptic on Android (the manifest lacks `VIBRATE`), NOTIF-10, GRP-3..10 ([cross-client-testing](cross-client-testing.md)), D2, D3 and #1520 (not reachable from the phone account).

**2026-10-06 (second pass), `v1.0.4-alpha.4` on the Mi 9T, same method.** Read and `PASS`: VIBRATE granted (#1535, no haptic can be felt on this phone's silent ringer), the salon reaction failure toast and rolled-back pill (#1536), the review pencil ring and the camera close (#1539), a scheduled post listed then published (#1520), the profile page (#1531), the signed calendar subscription (#1541), the tab swipe, the resume reload (`reloaded`). **Still `FAIL`: NOTIF-10** - one batched real banner and three refused pushes leave one nameless line ([backlog](device-readings-2026-10.md)).

**2026-10-07 (third pass), `v1.0.4-alpha.5` on the Mi 9T (debug APK built from tag `1be223001`, identical to `10115526c` apart from the version bump, versionCode 100000405, installed over the previous one; LOCAL estate rebuilt from the same tree).** Read and `PASS`: the reply context is per conversation (#1548: armed in the DM, absent in the salon, back in the DM), the reel camera opens on the FRONT lens and the flip control swaps front and back both ways (#1552, log `[camera] opened user: camera 1, facing front`, then `environment: camera 0, facing back`), the signed calendar subscription (sign 201, feed 200 signed, 403 unsigned), the post composer draft is keyed by an owner hash (#1549; only ONE account is enrolled on the phone, so the cross-account isolation itself is not observable here), the profile page, the four-tab bar, the tab swipe, a scheduled post listed then published on the minute. The JNI call of #1550 (`ZJI`, `covers`) ran with no `UnsatisfiedLinkError` or `NoSuchMethodError`. **Still `FAIL`: NOTIF-10** - the batching works only when one banner stands for several messages; a run where each message got its own real banner long before its push arrived still leaves one nameless line ([backlog](device-readings-2026-10.md)).

**Android is done except B-bis, H, K, L, M and R.** The full ladder was run on **v0.11.7** on 2026-07-31 (log
archived on the user's desktop) after partial runs on v0.11.5 and v0.11.6. Two defects came out of
it, both tracked as WP-NOTIF-1 and both re-checked by **check K**. **Check H was recorded PASS and
was not one**: the user reported on 2026-08-01 that a tapped notification still does not open the
conversation. That is the lesson this file exists for - a check whose verdict is "it looked right"
is not a check, so H now names the log lines that decide it.

**iOS WAS UNRUNNABLE UNTIL 2026-08-27** - there was no iPhone, and every iOS cell was BLOCKED rather
than pending (the user, 2026-08-18). An iPhone (iOS 18.7) has run against production since, so iOS
cells are now OWED and schedulable; check S is the only one that has actually run. **There is still
no iPad, and on 2026-08-30 that stopped being an academic gap**: App Review ran one, and the login
defect it found had been in every build the store ever had - check T, and the paragraph there saying
why an iPhone settles that particular check for both.

**iPad: switching into Canari from another app does not rotate the window (reported 2026-08-28)** - needs an iPad. Android phone rotation is decided: portrait under 600 dp, free on a tablet (`canari_lock_portrait`, [mobile](frontend/mobile.md#the-window-layout-the-keyboard-and-the-orientation-lock)). **iOS lifecycle classes (suspension and resume, the WebView evicted under memory pressure, a socket that does not come back; named by the user 2026-08-27) are closed by lettered checks here, one at a time, never by a fix written against a lifecycle bug nobody has seen** - three of three iOS defects so far were invisible to every gate.

Two consequences to carry deliberately rather than rediscover:

- **The iOS half of the app ships on compilation alone**, and compilation proves nothing about
  running. Every iOS-specific claim in this wiki is a claim about source, not behaviour.
- **v0.14.0's App Store publication was never verified, and `minClientVersion` is 0.14.0** - so any
  iOS user the store has not reached is locked out, with nothing here able to detect it. The user
  decided on 2026-08-18 to leave it as is. It is recorded because the state is real, not because
  something is owed.

Before 2026-08-27 not one check had ever run on iOS hardware, and only check S has since. The iOS half of WP-SEC-1 and WP-IOS-1 has only ever been
compiled, and a green CI run is not
proof a given file compiled - the pbxproj is hand-maintained, so grep the log for
`SwiftCompile ...<file>.swift` / `CompileC ...<file>.o` before believing any of it. That caveat is
iOS-only: Tauri runs Gradle quietly, so there is no Kotlin task line to look for, and Gradle
compiles by source set, so no Kotlin file can be silently skipped.

**The build to test both platforms on** is the 2026-08-01 compile run of `2b5ba1b0` (v0.11.8), both
workflows green - iOS [`30704254549`](https://github.com/emse-students/canari/actions/runs/30704254549),
Android [`30704255667`](https://github.com/emse-students/canari/actions/runs/30704255667). A
`workflow_dispatch` publishes nothing (Release, TestFlight and Play upload are each gated on
`workflow_run`), so take the **artifact**: the Android APK carries WP-DEEPLINK-1, WP-NOTIF-1 and the
WP-XP-7 removal at once, which means H, I, K and the dev-panel check all ride a single install.

| Check | Closes | Android | iOS |
|---|---|---|---|
| B | WP-VERIF-0 (background decrypt), WP-VERIF-2 | PASS v0.11.7 | owed |
| B-bis | `G2` - a dismissed notification not coming back at launch, and a new one still arriving | **owed** | n/a (the record is Android's) |
| B-reel | WP-RC-7 - a CanaReel sent in a DM, a group and a salon reads as one on the lock screen of a killed app, in French and English | **owed** (needs a sender with the RC-4 writer switched on) | owed (same) |
| D, E | WP-VERIF-0 (PIN change, fresh install) | PASS v0.11.7 | owed |
| F | WP-VERIF-1 | PASS v0.11.7 | owed |
| G | WP-VERIF-3 | PASS v0.11.6 | owed |
| H | WP-DEEPLINK-1 residual | **RE-OPENED** (the v0.11.7 pass missed the DM half) | owed |
| I | WP-UI-1 residual | PASS v0.11.7 | owed |
| J | WP-VERIF-4 | PASS v0.11.7 | owed |
| K | WP-NOTIF-1 | **steps 1-4 PASS on A1 0.14.12, 2026-08-30** (every line named below, observed end to end). Step 5 (self avatar) not observed; **K2 still owed** | owed |
| L | WP-DEV-PANEL-1 | owed | owed |
| M | WP-POST-DOC-2 | **PASS** on A1 0.13.0, 2026-08-06 (chat half) | `docs/wiki/cross-client-testing.md` |
| N | Offline unlock + promotion | owed | owed |
| O | WP-STORE-1 (install source + version gate) | owed | n/a |
| P | Cookie durability across a kill (the iOS half of WP-ANDROID-SESS-1) | n/a (fixed + verified) | owed |
| R | The shrunk release APK still having what it needs | owed | n/a |
| S | An iPhone obtaining a push token AT ALL (the P1 of 2026-08-27) | n/a (49 rows, healthy) | **RUN 2026-08-28 on 0.14.8: report PASSES, token FAILS.** Cause found and fixed the same day - **RE-RUN OWED on the build carrying it** |

**The `ios-release` artifact CANNOT be installed on a device, and this paragraph said to install it
until 2026-09-07.** The export is `method: app-store-connect` signed *Apple Distribution*
(`.github/workflows/ios.yml`, the `ExportOptions.plist` heredoc): that profile names no device UDID
and carries no `get-task-allow`, so `installd` refuses the `.ipa` outright - App Store Connect is the
only thing that accepts it. A dispatch does not upload to TestFlight either, so TestFlight stays on
the previous build and check K would be meaningless on it. **A `workflow_dispatch` therefore puts an
iOS build on no hardware at all** - an iOS pass costs a PRE-RELEASE, whose TestFlight upload is the
only thing that reaches a phone.

**What lifts it is a second export from the same archive**, `method: development` against a profile
naming the test device's UDID. It also buys `get-task-allow`, which is what makes the WKWebView
inspectable - so the one change that makes an artifact installable is the same change that makes the
webview readable. Owed, not done.

## The layout pass of 2026-09-09, and the sixth check that ran later the same day

Six fixes shipped in `v0.16.6-alpha.5`'s ancestors on the strength of a browser emulated at 393px.
**The Mi 9T reports 436 CSS px**, not 393, which is the first reason to run them on glass: every
breakpoint claim was made against the wrong number, and it happened to survive. Built from a tree
carrying all six (`bun a1apk.mjs`, code 1600605) and driven over CDP, element by element.

**Five measured, all PASS.** Each line is the number that decides it, not an impression:

| What was reported | What the phone answers |
| --- | --- |
| the reaction picker ran off the right edge | the row is 363px inside a 436px viewport, `scrollWidth - clientWidth = 0`, all eight reactions between x=42 and x=395. Nothing behind a scroll |
| the associations header overlapped its own buttons | the block is `flex-direction: column` under `sm`, so the title owns the whole row at **404px** where it had 99.6, `scrollWidth - clientWidth = 0`, and the two controls sit on their own line below. No pair of boxes intersects |
| the agenda was a seven-column grid on a phone | **no element in the tree has seven grid columns**, and every day number shares one `left` (33) - a single gutter, which is what makes it a schedule. Today carries `rgb(255, 212, 93)` and no other day does. Day 13 is absent between 12 and 14, so an empty day draws nothing |
| the conversation header painted over the message panel | the sheet is now **a direct child of `<body>`, `position: fixed`, `z-index: 160`** - one entry in its whole ancestry, so it is in the ROOT stacking context. `elementFromPoint` at the header's centre returns the sheet's scrim, and the header is `z-index: 20`. Verified on an OWN message, which is the case the report named: Modifier and Supprimer are both in the panel |
| the voice note was three taps | all FIVE outcomes of one gesture, on glass: hold-and-release keeps it, sliding left past 96px discards it, sliding right past 72px locks it **while the finger is still down**, and the locked bar's two buttons keep or discard. A locked recording ran 0:23 -> 0:31 with nothing touching the screen |

**The sixth ran once its precondition was arranged, and BOTH halves pass.** A proposed event is
supposed to notify an association's calendar managers ([#465]), and the phone's account held no
calendar-validator grant on any association - the precondition is not ambient, and it is more
specific than it first looked: the recipient query is `a.isBDE = true AND (permissions &
VALIDATE_EVENTS)`, so the grant must be on **the BDE**, while the proposer needs `PROPOSE_EVENT` on
a NON-BDE association. **That last clause stopped being true on 2026-09-14** - no creation path
validates any more, whoever asks, so a proposal is now the only outcome and the precondition it
described is gone ([social-service](services/social-service.md#nothing-is-validated-by-the-act-of-creating-it)).
It is left here because the 2026-09-09 run was arranged around it.
Both grants name their account by its OIDC SUBJECT (`subjectFor` in the harness's `accounts.mjs`),
because the display name that was used for this on the morning of the same day granted the wrong
user and produced a P1 ([testing-methodology](testing-methodology.md)).

| half | measured on the Mi 9T, 2026-09-09 |
| --- | --- |
| the shade | **2 271 ms** from the proposal, app in the background. Channel `canari_social`, `BigTextStyle`, `AUTO_CANCEL`, `timeout=PT72H`, a `contentIntent` that starts the activity. Title `Evenement a valider`, body `Canari Test Beta propose << Proposition agenda 496596 >>` - composed by the PHONE from its own `values/strings.xml`, which is the whole point of the key-not-a-sentence seam |
| the in-app row | `Canari Test Beta propose un evenement` + the title, marked `Nouveau`, with a relative time. It renders from Paraglide's `notif_event_proposed_text`, NOT from the native table |
| the fan-out | two `event_proposed` rows written, to both `VALIDATE_EVENTS` holders on the BDE - the phone's account and one other. The event stayed `status=pending` |

**A ROUTE CHANGE IS NOT A REFETCH, and the first reading of the in-app half was a false negative.**
Pushing `/notifications` through `history.pushState` rendered the page and found nothing; the same
page after a reload showed the row. Anything asking whether a LIST contains something must make the
list fetch, or it is reading the one it already had.

**Two defects came out of reading the notification rather than counting it.** The agenda's five
resource pairs had shipped **with their accents stripped** - `Evenement a valider`, `Evenement
valide` - while every neighbour in the same file carries them, and the loss changes the word:
`valide` is an adjective, `valide` with its acute a participle. In the same file the two FORM pairs
were still ENGLISH on the legacy side while the resource beside them had been French for weeks, so
the oldest clients got the one language the app does not speak. Both are fixed, and both are now
held by a test that compares the server's `legacyTitle`/`legacyBody` against the Android resource
for every key - two copies of one sentence that nothing had ever compared. **The in-app row was
correct throughout**, which is exactly why neither was noticed: the two halves read from two
different string tables, and only the native one was written without accents.

**The estate is left as it was found**: both grants, the proposed event and the two notification
rows were deleted by an allowlist on the marker role and the marker title, and both accounts read
zero memberships afterwards - an undeclared membership reattributes whatever the next run measures.

**One thing the pass found that no report had asked about**, filed rather than fixed here: the
composer's pending-attachment chip painted its filename TWICE - a `span.line-clamp-2` inside the tile
and a `div.truncate` under it, overlapping by 7 px in a 62 px column and disagreeing about how to
shorten the name. **Closed the same day by #470**, which left one name and the guard that keeps it
that way (`ChatComposer.attachments.svelte.test.ts`, *"writes a plain file name exactly once, where
it used to write it twice"*). The story is in `CHANGELOG.md`; the backlog entry is gone, because the
backlog is only what is left to do.

**And one instrument came out of it.** `cdp.mjs` could click and it could drag to another element;
it could not HOLD. `holdAndSlide` slides a distance rather than to a node - a threshold has no node
to name - and `release: false` leaves the pointer down, without which `holding` and `locked` cannot
be observed at all: both are gone by the time a release lands.

## Putting the phone at a chosen CSS width - the four densities, measured

**The Mi 9T is 436 CSS px at its own settings, and every phone breakpoint in this repo is written
for 390, 375 or 360.** So a layout check on glass has to move the device to the width it is about
to make a claim about, rather than make the claim at 436 and hope. The screen is 1080 physical
px wide and Android's CSS scale is `density / 160`, so the width is `172800 / density` - and the
four values that matter were **measured on the device**, not computed and trusted (2026-09-14,
`window.innerWidth` read over CDP, app 0.16.6):

| `adb shell wm density <n>` | `window.innerWidth` | what it is for |
| --- | --- | --- |
| 443 | **390** | the phone width every sweep in this repo uses |
| 461 | **375** | the reference width the truncation budgets are derived at ([design-reference](frontend/design-reference.md)) |
| 480 | **360** | the narrow end - where a string that merely fits at 390 is cut |
| **396** | **436** | **A1's baseline. Restore it when you are done.** |

`wm density` with no argument prints both the physical and the override, which is how you check you
put it back. Two traps: the change **restarts the app**, so a devtools forward made before it points
at a dead process - re-read `pidof fr.emse.canari` and forward again; and the socket is
`localabstract:webview_devtools_remote_<pid>`, **not** `chrome_devtools_remote`, which answers
nothing and looks like a dead WebView rather than a wrong name.

## Before you start

- **KNOW WHAT THE DEVICE IS RUNNING, before anything else.** Not `versionName` - that is a constant
  edited at release time and it read `0.13.1` for both a current build and a stale one on 2026-08-11.
  Two readings that cannot be faked:

  ```
  adb shell dumpsys package fr.emse.canari | grep -E "pkgFlags|signatures|lastUpdateTime"
  ```

  `pkgFlags=[ DEBUGGABLE ]` means a debug APK, which is **~10x slower than release on the same
  fixture** (WP-ANR-1's own measurement) - every behavioural check still holds, every timing verdict
  is void. And a debug-keystore install cannot be replaced by a release-signed APK
  (`INSTALL_FAILED_UPDATE_INCOMPATIBLE`): crossing that line needs an **uninstall, which wipes
  `mls.bin`** and re-enrols the device, so it is a decision to take before the setup, never at the
  install step. **That refusal is SYMMETRIC and names neither side** - it fires just as well when
  the phone carries the release build and the APK is the debug one, which is the case in which the
  uninstall has ALREADY happened; `pkgFlags` answers which is which. **And afterwards nothing says
  it happened**: the replacement package reads the right version and launches, so the only witness
  is that `install -r` preserves `firstInstallTime` and a fresh install does not. **`firstInstallTime
  == lastUpdateTime` means a NEW device** - no enrolment, no MLS store, and `POST_NOTIFICATIONS`
  back to denied, which a push check needs granted. `a1apk.mjs` prints all of it after every
  install. **A1 lost its device this way on 2026-09-24**: a release APK built to verify the WebView
  devtools fix was installed over the rig's debug build, and the uninstall that allowed it took the
  enrolment with it - the phone now carries a device created 2026-09-24 03:11 and joined to nothing.
  Then date the CODE from a string the running app logs - `git log -S "<that line>"` -
  because a log string is version-stamped evidence the process hands you for free. See rule 17 in
  [testing-methodology](testing-methodology.md).
- **KNOW WHICH ESTATE THE BUILD POINTS AT, because it decides what EMPTINESS means.** Read it from
  the client's own request origins, never from the build's name. The test population - the accounts
  the harness drives, their conversations, their history - lives on the **LOCAL** estate; a phone
  pointed at `dev.canari-emse.fr` has neither those accounts nor any MLS state of its own, so
  `/chat` reading "Aucune discussion" there is the expected reading of a new device on an empty
  estate, not a defect. The same holds for a directory search that returns nothing. Measured on A1
  on 2026-09-14, where it cost a session's worth of readings before it was noticed.
- **A PHONE CANNOT BE PUT IN LANDSCAPE, AND A MANIFEST GREP ANSWERS THAT QUESTION WITH SILENCE.**
  The lock is in Kotlin, not the manifest: `MainActivity.kt:47-53` sets
  `SCREEN_ORIENTATION_PORTRAIT` when the resource boolean `R.bool.canari_lock_portrait` is true and
  leaves `SCREEN_ORIENTATION_UNSPECIFIED` otherwise, so a tablet keeps its rotation.
  `android:screenOrientation` takes one literal value and cannot serve both, which is why a resource
  qualifier carries it.
- **A second account.** Every push check needs a peer to send from. A second phone, or the web app
  in another browser profile, both work.
- **A log capture.** iOS: Console.app or the Xcode device console, filtered on the app and on
  `fr.emse.canari.push` for the notification extension. Android (check K only):
  **[`tools/android/verify-on-device.py`](../../tools/android/verify-on-device.py)** - a tkinter GUI
  that builds, installs, and tails per-device logcat with this runbook's tags already whitelisted.
- **Screen genuinely locked, app genuinely killed** for B. A backgrounded app is a different code
  path and passing it proves nothing about the one under test.

---

## B. Decrypted push, app killed, screen locked

**Proves** the whole background chain: FCM wakes the extension, the keychain hands back the device
key, the MLS state loads read-only, and the ciphertext decrypts. On iOS this is the first ever
proof that background decrypt works at all.

1. Kill the app. Lock the screen.
2. From the peer account, send a DM with recognisable text.
3. Read the notification on the lock screen **without unlocking**.

**Pass** = the notification shows the actual message text. A generic "Nouveau message" is a FAIL -
it is the fallback for a decrypt that did not happen.

**Where to look:** Console.app, filtered on the `fr.emse.canari.push` extension process. The Rust
`[MLS]` lines are the same code as Android's, so `[MLS] Keystore key failed to decrypt blob - key
deleted.` means the same thing here. iOS keychain service is `fr.emse.canari`, accounts
`mls_key_<alias>` and `mls_bg_key_<alias>`. The Android equivalents, for comparison, are tags
`CanariFCM` and `MlsDeviceKeyStore`, ending in `decryptProto: success type=... -> "..."`.

**Known limit, not a bug:** background decrypt is read-only and applies no commits, so a message
sent in a *newer epoch* than the persisted state cannot be decrypted and correctly falls back to
the generic text. `decryptProtoWithCommits: success after catch-up` is the in-memory catch-up path
succeeding. If a check fails, confirm which of the two you are looking at before filing anything.

## B-bis. A DISMISSED notification does not come back at the next launch - owed on Android

**Proves** the one thing no gate here can see: that the builder's durable record of what it has
announced (`canari_alerted_messages`) actually survives the process and is consulted. The vitest
suite `dismissedNotificationReplay.test.ts` reads the Kotlin source and proves the code is WRITTEN;
only a phone proves the shade stays empty.

1. Kill the app. From the peer account, send a DM with recognisable text.
2. Wait for the notification, then **swipe it away** without opening the app.
3. Launch the app and let the startup catch-up finish.

**Pass** = nothing reappears in the shade, and the message is in the conversation. A notification for
that same message is a FAIL: the push was redelivered over the socket (it was never ACKed) and the
record did not recognise it.

**Then, in the same run, the case that must NOT be silenced:** with the app killed again, have the
peer send a SECOND message and do not dismiss it. Open the app. Dismiss nothing. Have the peer send a
THIRD. **Pass** = the third notifies. A silent third means the record is behaving like a watermark
rather than a set, which is the failure mode its shape exists to avoid.

**Where to look:** `adb logcat -s CanariFCM`. `showMessageNotification: already announced and
dismissed -> nothing posted` is the suppression firing; `already in the shade -> refreshed without
alerting` is the OTHER guard (the notification was still visible) and does not test this one.

**Known limit, not a bug:** a SALON message is not covered. Its push payload carries no timestamp, so
the builder can identify no message of its own and never guesses - see `docs/wiki/backlog.md`.

## B-reel. A CanaReel announces itself on the lock screen of a killed app - owed on BOTH platforms

**Proves** WP-RC-7 where no gate here reaches: the Rust scanner reads `MediaMsg.intent` and words
the line (`mobile/push_text.rs`, `PushText::Reel`), but only a phone proves that the line it returns
is the one the Android service and the iOS NSE post, through all three decrypt paths - MLS for a DM
and a group, Graine for a salon - and that no thumbnail is ever attempted
([reels-in-chat](frontend/modules/reels-in-chat.md#push-text)).

**Precondition, not ambient:** the SENDER must run a build with the reel writer (RC-4, behind its OFF
switch) turned on; nothing else can produce a reel message. The receiving phone runs any build
carrying RC-7.

1. On the receiving phone set the app language to **French** (Settings, inside Canari - not the
   phone's). Kill the app. Lock the screen.
2. From the peer, send a CanaReel with NO caption in a **DM**, then one in a **group**, then one in a
   **salon** of a shared community.
3. Read each notification on the lock screen **without unlocking**.
4. Send one more in the DM WITH a caption.
5. Open the app once (so the locale is mirrored), switch the app language to **English**, kill it,
   lock, and repeat 2-4.

**Pass** = French: the DM reads `🎬 CanaReel` under the sender's name, the group and the salon read
it under their own titles as any message does there, and the captioned one reads `🎬 CanaReel : <caption>`;
English: `🎬 CanaReel` and `🎬 CanaReel: <caption>`. **No picture** on any of them. **FAIL** =
`🎥 Vidéo` / `🎥 Video` (the receiving build does not carry RC-7, or the sender did not declare the
intent), a generic "Nouveau message" (the decrypt did not happen: that is check B's failure, not this
one's), or any thumbnail.

**Where to look:** Android `adb logcat -s CanariFCM`: `decryptProto: success type=media -> "🎬 CanaReel"`
(`decryptProtoWithCommits` after a catch-up; the salon's Graine path logs its own open). iOS:
Console.app on the `fr.emse.canari.push` process (`[CanariNSE]`). The Rust
`[MediaBG] ... reel=true - no thumbnail, key withheld` line is a `debug` line of a process the app's
logger may not run in - its absence proves nothing; the missing picture is the reading.

## C. The row a push creates carries the GROUP's name - owed on BOTH platforms

**Proves** the half of the push cache no browser can reach. `consumeFcmCache` writes a placeholder
conversation row beside the message - it must, the message has a foreign key to `conversations(id)` -
and until 2026-09-15 it labelled that row with the SENDER. For a DM the two coincide; for a group it
was whoever spoke first, and the label was never corrected afterwards, so a two-person group sat in
the sidebar under the other member's name directly above the real DM with that same person.

The decision is pinned deterministically (`pushConversationLabel.test.ts`, and
`fcmCacheFields.test.ts` for the two native writers), so what is owed here is the one thing neither
can see: that the group name really is in `data["groupName"]` on a delivered push, and really does
reach the file.

1. From the peer account, create a group with a distinctive name, and add this device to it.
2. **Kill the app** - the cache path only runs when the app was not up to receive the frame.
3. From the peer account, send one message into that group.
4. Open the app and read the sidebar **before** the MLS sync finishes (the row is drawn from the
   cache first - that is the whole point of the pre-injection).

**Pass** = the row carries the GROUP's name. **FAIL** = it carries the sender's name, which is the
defect, or the group id / "Groupe", which means `groupName` arrived empty and the server half is
what to look at.

**Where to look:** `adb logcat -s CanariFCM` for the delivered `data` map, then the app's own
`[FCM_CACHE]` lines. A `[DISCOVERY] ... relabelled "<sender>" -> "<group>"` line afterwards is the
REPAIR firing, which is a pass for the repair and means step 4 was read too late to see the cache
label.

**THE "CHEAPER CASE" DOES NOT EXIST, AND THIS PARAGRAPH USED TO CLAIM IT DID.** Renaming the group
from the peer account while this device is away was offered here as a way to reach the repair without
a push. It cannot: `groupRenamed` is a DURABLE frame, so the device that was away receives it on
reconnect and applies the new name through route ONE. Discovery then finds the two names already
equal and correctly says nothing. Measured 2026-09-15 on a web client - 371 console lines, zero
relabel lines, the new name on screen in 1 ms. The seam is only reachable when the local label is
wrong and no frame is coming to fix it, which is what a push placeholder leaves behind and is
therefore the push case above. Reaching it deliberately means writing the wrong label straight into
the device's own store, with an observer attached before the reload - a rig procedure, not a
hardware check.

## D. PIN change, then repeat B

**Proves** that rewriting the device key under the same alias leaves the background reader working -
this is where a writer/reader format mismatch shows up.

1. Change the PIN in the app.
2. Repeat B.

**Verdict:** `[MLS][Tauri] Device key changed - state re-encrypted and persisted.` in the app log,
then a full pass of B. A pass on B *before* the change and a fail after is the signature of the
alias being written in a format its reader does not accept.

## E. Fresh install + login, then repeat B

**Proves** the same chain on a device with no migration history - the path every new user takes,
and the only install path still tested (the upgrade path was retired on 2026-07-31: staging it now
means deliberately downgrading to a pre-WP-SEC-1 build, and every install worth testing has long
since migrated).

1. Uninstall completely. Install from TestFlight. Log in.
2. Repeat B.

## F. Login end to end: init, save, KeyPackage

**Proves** WP-VERIF-1. On the login of check E, confirm in the app log:

- `[DB] Using SQLite storage (Tauri)` - and **never** the IndexedDB fallback. That fallback is a last
  resort, not a mode; seeing it means `SqliteStorage.init()` threw.
- `KeyPackage published.` - without this, no peer can invite this device.
- A relaunch restores the conversation list, which is the only proof the state was actually saved.

## G. Biometrics: enable, relaunch, disable, and the PIN modal

**Proves** WP-VERIF-3.

1. **Enable** biometric unlock from the profile screen. The prompt must show **two** app-supplied
   lines on iOS, not four: a title naming the action and a generic confirmation line. (Android
   stacks title+subtitle+description and adds its own hint - four fields, four lines. Same strings,
   different shape.) No string anywhere may name a sensor - there is no Face ID on Android and no
   fingerprint on a Face-ID-only iPhone.
2. **Relaunch** and unlock with the face/finger. The login must complete, *not* fall back to the PIN
   modal after a successful biometric.
   - `[BIOMETRIC] Biometric login attempt`
   - `[BIOMETRIC] Authenticating for userId=... via device keystore...`
   - `[BIOMETRIC] Skipping PIN verification - using device keystore...` &larr; the decisive one. Its
     absence with the two lines above present is exactly the v0.11.4 failure.
3. **No swallowed first tap.** `[LOGIN] Call ignored, a login already owns the flow` must appear
   **nowhere**: `isLoginInProgress` is one flag with two owners, and an entry point that does not
   release it before `loginImpl` makes every cold launch refuse its own automatic attempt -
   deterministic, not a race.
4. **The biometric session must persist its messages.** A biometric session used to run with an
   empty device key in the WebView, so nothing it received was written to SQLite and nothing already
   stored could be read. Expect zero `Failed to decrypt SQLite row`, one biometric prompt per login,
   and `MLS state loaded from mls.bin (native).` naming the right backend. The decisive line is
   `[HISTORY_BUNDLE] Full history sent: N message(s)` where N has **grown** by the messages received
   under biometrics: the bundle is built by reading the local store back with the device key, so a
   grown N proves the session both wrote and read. `[FCM_CACHE] Injection done: 1/1` confirms the
   same for the push cache.
5. **The PIN modal keeps its "use biometrics" button** when biometrics are enrolled. It derives that
   button from the same flag as the sheet, so if the sheet stops opening the button vanishes too.
6. **Disable** biometric unlock, relaunch, confirm the PIN is required and the keychain entry is
   really gone (the biometric sheet must not appear at all).

## H. Deep link from an OS notification tap - RE-OPENED on Android

**Proves** the WP-DEEPLINK-1 residual. The fix is verified on the web for the two link paths; the
notification tap could not be driven from a headless browser. It publishes to `notifNav` exactly like
the two verified paths.

**RUN IT TWICE - backgrounded, then from a KILLED app.** They are not the same code path and they
have never both worked: a running app receives the URL over the `onOpenUrl` *event*, a cold start has
to *ask* for it with `getCurrent()`, and only the second is gated by the Tauri capability file. The
grant was missing outright, so the cold start failed on every launch while the backgrounded case was
perfect — see
[`mobile.md`](frontend/mobile.md#how-a-deep-link-actually-reaches-the-app--two-paths-only-one-of-them-gated).
This is what the user reported on 2026-08-01 and what NOTIF-7 finally measured on 2026-08-07;
fixed in `916ed696`. **A pass on the backgrounded case alone proves nothing about the one users hit**,
which is a tap on a notification that woke them up.

1. Kill the app. Have the peer send a DM, then a channel message.
2. Tap each notification. Each must land in the right conversation, **not** merely the right tab.
3. Repeat with the app merely backgrounded (HOME, not killed).
4. **With the session dead** (sign in, delete the device's session server-side, kill the app), tap a
   POST push: the app must land on `/login?returnTo=%2Fpost%2F<id>` and, after signing in, on the post
   ([sessions](sessions.md#a-dead-session-sends-the-user-to-login-carrying-where-they-were-going-2026-10-09)).
   Read `[AUTH] Session expired - logging out and redirecting to /login?returnTo=...` in the log. A bare
   `/login` means the deep link never reached `goto` (then `[hooks] Processing URL` is absent too, and
   the fault is upstream of this fix: read `[hooks] launch URL read on attempt N`).

**Read the log, not just the screen.** This check was recorded PASS on v0.11.7 and the DM half was
broken the whole time: the tap does reach the right tab, and "right tab" is what a pass looks like
from across the room. Three lines, in order, and each one names the hop that failed if it is the
last one you see:

- `[notifNav] deep link received: fr.emse.canari://chat/<id> -> target <id>` - everything native
  worked (PendingIntent, `onNewIntent`, the deep-link plugin, `hooks.client.ts`). Absent: the
  failure is upstream of the product code, and none of the JS below ever ran. Split it further with
  `[hooks] Deep-link listener registered` (the WebView booted) and
  `[hooks] deep-link getCurrent() failed` (the cold-start path was refused - a capability gap, not a
  native one).
- `[notifNav] routing to /chat|/communities for pending conversation <id>` - only printed when a
  route change was actually needed.
- The thread on screen, with its history. A DM that lands and then empties is the landing being
  ended by its own selection - the group-id-vs-map-key bug fixed on 2026-08-01.

Remember `/c/<groupId>` and `/chat/<groupId>` are not routes: a conversation opens by publishing to
`notifNav`, and a channel target can only be opened on `/communities`.

## I. The enrolment sheet under a light theme

**Proves** the WP-UI-1 residual. The enrolment sheet reported DARK under a LIGHT theme. The `dark:`
variant is correct on web (verified by computed style in both themes), so the suspect is the native
runtime.

Set the phone to light mode, open the biometric enrolment sheet, and see whether it renders light.

## J. Outbox retry worker (short version)

**Proves** WP-VERIF-4 partially: that the worker wakes and drains. The three-failure branch (a
persistent flag plus a nudge notification) is deliberately **not** covered here - it needs the network
down long enough to exhaust the backoff.

1. Airplane mode on. Send a message. Close the app.
2. Airplane mode off. Wait ~1 minute.
3. The message must arrive without reopening the app.

**Verdict:** iOS schedules the work as `fr.emse.canari.outboxRetry` via `BGTaskScheduler`, which the
OS runs on its own schedule - so an **iOS failure here is inconclusive rather than a defect**. The
Android equivalent (tag `CanariOutboxRetry`) already passed and is not owed.

## K. The notification quick reply - owed on BOTH platforms

**Proves** WP-NOTIF-1 (a) and (b); K2 below proves (c). The reply always did send; what it left behind was nothing. It is
built natively and never becomes an outbox entry, and `reconcileOutboxSent` only ever DELETES, so
the sender's own conversation showed the reply nowhere. Both platforms now write the delivered reply
into `fcm_message_cache.ndjson` under OUR user id.

1. Kill the app. Have the peer send a DM.
2. Answer from the notification itself, **without opening the app**.
3. Confirm the peer receives it (`sendQueuedMessagePush: HTTP 201`, `1 sent, 0 remaining`).
4. **Reopen the app.** The reply must be in your own conversation - that is the half that was
   missing.
5. **Android only:** in the notification thread, your own avatar must be drawn, not a blank
   placeholder. (iOS has no self `Person`, so this half does not apply.)

**K2 - the UNDELIVERED reply, WP-NOTIF-1 (c).** This used to be listed here as out of scope; it is
fixed now, and it is the half most likely to still be wrong, because unlike (a) and (b) it has no
compile check worth the name - it is pure TS + Rust, so it built the moment it was written.

An undelivered reply lives only in `outbox_pending.ndjson`, and `store_outbox_mirror` rewrites that
file wholesale from the TS queue, which has never heard of it. `adoptOrphanedMirrorEntries` now runs
at login, before conversations load, and turns every unknown mirror line back into a real outbox
entry plus its local message.

1. Put the device in airplane mode, then have the peer send a DM (send it *before* going offline, or
   there is no notification to answer).
2. Answer from the notification. The drain must FAIL - the point is a reply that never left.
3. Reopen the app, still offline. The reply must be in your conversation, marked pending.
4. Restore the network. It must send on its own, without retyping it.

**Verdict lines:** `[OUTBOX_MIRROR]` adoption at login, then the ordinary `[OUTBOX]` flush. A silent
proto stays `control` and is sent verbatim with no push - that is intended, not a miss.

### Steps 1-4 MEASURED on A1 0.14.12, 2026-08-30 - the reported defect does NOT reproduce

**The report that the quick reply "does not work" is not true of this build.** The whole chain was
observed, and each of the three causes the [backlog](backlog.md) entry left open is eliminated by a
line rather than by an argument:

```
07:20:17  Start proc 17650:fr.emse.canari for broadcast {FirebaseInstanceIdReceiver}
07:25:46  CanariNotifAction: handleReply: queued id=45ae4d3c group=642f389a
07:25:46  CanariFCM: drainOutboxBackground: 1 message(s) queued, taking 1
07:25:50  CanariFCM: sendQueuedMessagePush: HTTP 201 group=642f389a msg=45ae4d3c
07:25:50  CanariFCM: drainOutboxBackground: 1 sent, 0 remaining
07:27:22  [OUTBOX_MIRROR] 1 entry/entries written
07:27:24  [OUTBOX_MIRROR] 1 background send(s) to reconcile
```

- **The app really was down.** The kill was `phone.killAndProveDead` (`deadInMs: 82`), and the only
  thing that restarted the process was the FCM broadcast itself - no `MainActivity`, no WebView, no
  WebSocket. That last part is what makes the rest mean anything.
- **The push decrypted in the background**: the shade carried the peer's display name and the
  message text, not one of `GENERIC_BODIES`, and `fcm_message_cache.ndjson` held the plaintext.
- **Step 4, the half that was missing, HOLDS.** Read on all three clients at once and without
  navigating any of them: the peer has the reply, and so does the phone's own conversation.
- **The native residue is clean afterwards**: `fcm_message_cache.ndjson` empty and no
  `outbox_pending.ndjson` at all, so the entry was adopted rather than stranded.

**PROVENANCE, BECAUSE IT DECIDES WHAT THIS IS WORTH.** The reply at 07:25:46 was typed by a PERSON on
the device, not by the harness - which is what this file's checks ask for, and why the row can be
taken at all. But it also means the run had no gate, no dirt classifier and no recorded ledger row:
**it is a MEASUREMENT, not a campaign verdict**, and NOTIF-6 on the board is not answered by it. Step
5 (the self avatar in the thread) was never looked at, and **K2 - the airplane-mode reply that must
NOT be delivered - is untouched and is still the half most likely to be wrong.**

### The BACKGROUNDED run that failed, and the defect it found

**A KILLED RUN IS THE BRANCH THAT HEALS THIS DEFECT, SO THE PASS ABOVE PROVED LESS THAN IT LOOKED.**
Re-run on 2026-08-30 with the app merely backgrounded - `am kill` never issued, process alive at
`proc=LAST`, `foregroundedAtSend: false` - the same reply on the same build, device and conversation
was refused:

```
07:55:57  CanariFCM: sendQueuedMessagePush: HTTP 201   <- app KILLED, fresh process
07:57     MainActivity resumed and unlocked -> /register mints a NEW secret,
          pending_push_secret.txt written (32 bytes, mtime 07:57)
07:59:30  CanariFCM: sendQueuedMessagePush: HTTP 403   <- app BACKGROUNDED, same process
```

The file was still sitting there unconsumed at 08:06, which per the code can only happen when the
Keystore answered first - with the previous process's secret, which `/register` had already
invalidated. Cause, fix and rules: [backlog](backlog.md), `CHANGELOG.md`,
[mobile](frontend/mobile.md), [durable-rules](durable-rules.md). Two further defects fell out of the
same branch: the `RemoteInput` spinner never ended (screenshot evidence: the action row was gone and
the reply text sat under a spinner eight minutes on), and no retry was ever scheduled.

**THE RE-MEASUREMENT IS OWED AND IS THE ONLY THING LEFT.** The fix is written, `assembleUniversalDebug`
is green and the APK is installed on A1 (`install -r`, data kept, 2026-08-30 08:16). It has never
been run. To re-arm the precondition - it is NOT ambient, and a run made without it proves nothing:

1. `adb shell input keyevent KEYCODE_HOME`, then `am kill fr.emse.canari`, and assert `pidof` is
   empty. **Never `force-stop`**, which puts the app in the STOPPED state and cancels every FCM
   broadcast.
2. `bun run.mjs --preflight A1` - it foregrounds, sends the app to `/chat` and unlocks the PIN.
   That unlock is what calls `/register` and writes the file.
3. **Assert the precondition is armed**: `run-as fr.emse.canari ls -l /data/data/fr.emse.canari/pending_push_secret.txt`
   must show 32 bytes. If the file is ABSENT the window is closed (a resume already migrated it) and
   the run measures nothing - go back to step 1. Use the PowerShell tool for this, never Bash, which
   rewrites the absolute device path.
4. `bun tools/cross-client-harness/archive/k.mjs`, then answer from the shade when it says to.
   **It is an atom now** - the `scratch/k-run.mjs` this line used to name never existed in the tree,
   which is the whole reason this re-measurement sat unmade for a week. It performs steps 1-3 itself
   and asserts each, so the only human part is the reply.

   **The backgrounded case CAN be answered since 2026-09-18**: the WebSocket trigger posts through the same Kotlin builder, so the shade carries `Repondre` there too ([mobile](frontend/mobile.md#notification-quick-actions-are-on-every-android-message-notification-whoever-posts-it-resolved-2026-09-18-audited-2026-10-10)). `k.mjs` still records `SKIPPED` rather than `FAIL` when no reply is made, so a run cannot be mistaken for a product verdict.
5. **Verdict lines:** `retrievePushSecret: newer secret adopted from pending_push_secret.txt -> Keystore`,
   then `sendQueuedMessagePush: HTTP 201`, then `1 sent, 0 remaining`. A `403` means the fix is
   wrong, not that the rig is.

One rig note, met twice: the adb daemon died mid-session and the preflight reported the PHONE
unreachable. `adb kill-server && adb start-server` fixes it, and it kills any background `logcat`
capture with it.

## L. A revoked device coming back - the dev panel

**Proves** WP-DEV-PANEL-1. The cause is known and fixed; only the recovery has never been seen run.
`registerDevice` never consulted the denylist, and `resolveDeviceId` restores the same id across
reinstalls on purpose - so a device deleted from the panel came back under its old id, got a 200,
and was then filtered out of `getUserDevices` and resolved to a null KeyPackage: enrolled, invisible,
never invitable, silent, forever. Registration now answers `403 DEVICE_REVOKED` and the client
re-enrols under a fresh identity.

1. On a second device, delete this device from the dev panel (or use one whose id was deleted
   earlier).
2. Relaunch the app on the deleted device and log in.

**Verdict:** `[MLS] Device <old> was revoked - re-enrolled as <new>`, then the panel lists the new
id and the device receives again. **It costs that device's local history, by design** - a new id IS
a new device, so do not run this on a device whose messages you want.

## M. A PDF preview, on Android

**Proves** WP-POST-DOC-2. Android is the platform that decides it: its WebView has no PDF engine,
which is the whole reason pdf.js was chosen over an `<iframe>`, and nothing in the compile or the
tests can tell you the canvas path works there.

The prod half of this is already fixed and **verified live on 2026-08-04**: nginx has no `.mjs` type,
so the worker was served as `application/octet-stream` and the module loader refused it. A `HEAD` on
`/_app/immutable/assets/pdf.worker.min.*.mjs` now answers `application/javascript`.

1. Open a post carrying a PDF: the first page must render full-width under the file row.
2. Open a chat message carrying a PDF: the same page must render in the 44 px icon square.

`ConversationMediaPanel` and `AssociationDocumentManager` show no preview on purpose - they list
files without fetching them - and a password-protected vault document cannot be decrypted without
its password at all. Neither is a failure.

**Step 2 PASSED on A1 0.13.0, 2026-08-06** (prod, PDF sent from W1). The rendered first page is an
`<img alt="Aperçu de la première page du document">` fed from a `blob:`, `naturalWidth` 116x116 in
a 44 px box - two of them, one per PDF sent. Logcat clean over the whole run.

Two traps this cost, both about ASSERTING the right thing rather than about the app. The preview is
an `<img>`, **not** a `<canvas>`: a check looking for a canvas reports FAIL on a surface that plainly
works, which only a screenshot caught. And a mounted `<img>` proves nothing on its own - a broken
picture keeps its `src` - so the assertion has to be `naturalWidth > 0`. Step 1 (a PDF in a POST) is
still owed.

---

## N. Offline unlock and the promotion back - owed on BOTH platforms

**Proves** the offline-unlock work. Nothing in a compile or a unit test can answer it: the whole
feature is about what a real cold start does when `POST /api/auth/refresh` cannot leave the device,
and both the keystore read and the SQLite store behave differently on hardware than under jsdom.

Requires biometrics enrolled, or "rester connecté" on. **A PIN-only account is expected to FAIL to
unlock offline** - that is the designed behaviour, not a defect.

1. Sign in normally, exchange a few messages, then force-quit the app.
2. Enable flight mode. Launch the app.
3. The biometric prompt appears and the conversation list opens on the local history. Verdict line:
   `[LOGIN] Offline unlock (no token) - local session, will promote on reconnect.`
   The offline banner is visible. It must appear **fast** - the version gate is short-circuited
   offline, so if the launch hangs ~26 s before the prompt, that short-circuit is not working.
4. Send a message. It stays `pending`, and the log must NOT show flush attempts:
   `[OUTBOX] Flush skipped - offline; the queue is kept intact for the next reconnect.`
   Repeated `transient failure (attempt N)` lines here are a failure - the queue is burning its
   backoff against an absent network.
5. Disable flight mode. Expect, in order:
   `[PROMOTE] Access token acquired`, `[WS] Connected to Chat Gateway`, then the outbox draining.
   The message turns `sent`, the banner clears, and anything the peer sent meanwhile arrives.
6. **The session-death half**, which is the one worth being careful about: unlock offline as above,
   revoke that session from Réglages > Connexions actives on another device, then restore the
   network. Expect `[PROMOTE] Session expired while offline - signing out.` and a redirect to
   `/login` - then sign back in and confirm **the full local history is still there**. Losing it
   would mean the logout wiped the encrypted store, which it must not.

## O. The update target, and the blocking version gate - owed on Android

**Proves** WP-STORE-1. The optional nag modal is gone (the version now sits passively in
`/settings` > A propos), so `minClientVersion` is the only thing that can interrupt a user, and the
destination it offers is resolved at **run time** from `installer_package.txt` - a Kotlin writer,
then `get_installer_package`, then `appVersion.ts`. `buildUpdateTarget` and the cross-process
contract are unit-tested; three things are not, and cannot be.

1. **The Kotlin actually compiles.** A `workflow_dispatch` run of `android.yml` is the only
   real compile of `recordInstallerPackage`. Nothing local exercises it.
2. **The target follows the install source.** On a **Play-installed** build the blocking gate must
   offer the Play Store; on a **sideloaded CI APK** it must offer the APK. Capture the verdict line
   with `tools/android/verify-on-device.py`:
   `[appVersion] install source: ...`
   Both sides have to be seen - the two paths differ only in that one string.
3. **The gate itself.** In `/admin/platform`, raise `minClientVersion` above the running version,
   confirm the app blocks with a button leading to the right destination, and **reset it
   afterwards**.

**Do not raise `minClientVersion` on prod until a build is actually live on Play.** Raising it
before the rollout has reached devices locks everyone out behind a button that leads to the version
they already have.

## P. The refresh cookie surviving a kill - owed on iOS

**Proves** that the iOS half of WP-ANDROID-SESS-1 does not exist. On Android the WebView cookie jar
is written lazily, so a kill with no lifecycle callback restored a refresh token one rotation behind
the one already spent; presenting it is a replay, and the server correctly revoked the session. The
fix forces `CookieManager.flush()` at the moment of rotation.

**iOS has no equivalent, and that is not the same as not needing one.** `WKHTTPCookieStore` exposes
no flush API at all, so `flush_webview_cookies` is a no-op there — a fact about the API, not
evidence about the behaviour. A suspended app swiped out of the switcher is terminated without
`applicationWillTerminate`, which is precisely the shape that broke Android.

1. Sign in. Use the app long enough for at least one refresh (5 min at the current cadence), so the
   stored cookie is *not* the one issued at login.
2. Send the app to the background, wait for it to be suspended, then swipe it out of the switcher.
3. Relaunch. It must come back **signed in**, first try.
4. Repeat immediately: a session revoked by a replay looks fine for exactly one launch.

A failure here looks like the login screen, or the app appearing signed in with nothing in it — and
it is confirmed server-side by a `revokedReason` of replay on the session row. If it fails, the
remedy is not a flush call (there is none): it is to stop depending on the jar's durability, e.g.
mirroring the rotation into the keychain the way the device key already is.

## Q. The conversation list scrolls clear of the bottom nav - CLEARED 2026-08-26 (Pixel 6a)

Ran on a freshly built and installed universal debug APK (bundle `2a4297cb`, built 15:04:49Z), which
matters because a CSS reservation is exactly the kind of change a stale bundle hides. Kept because
**two of its four criteria did not follow from the mechanism and one of the four turned out to be a
dead instrument** - all three discovered by running it, and each would have returned a false verdict.

| # | Criterion | Result |
| --- | --- | --- |
| 1 | `scrollHeight > clientHeight` on the list | **796 > 744**, where it read `744 === 744` before |
| 2 | `paddingBottom` carries `4rem` + safe-area | **88px** = 64 + 24, so the reservation reached the bundle |
| 3 | Scrolled to the end, the last tile clears the nav | bottom **878 -> 826**, exactly the nav top; `elementFromPoint` returns the TILE |
| 4 | A real swipe moves the accessibility tree | **VOID - see below** |

Geometry checks out to the pixel: 698 px of tiles + 10 px top padding + 88 px reservation = 796.
`clientHeight` stayed 744, and the nav still sits topmost at the list's bottom edge - both as
predicted once the box model is read correctly, and both the reason the original criteria 1 and 3
were wrong (they asked for a shorter box and for the nav to stop being hit there; neither can happen).

**Criterion 4 is void, and this is the important finding.** A `Swipe-Tool` gesture demonstrably drives
the scroll - CDP read `scrollTop` 0 -> 52 -> 0 across a swipe up and a swipe back, the full range -
and the user confirmed it by hand. The accessibility tree reported **identical tile coordinates before
and after**, to the pixel. So the tree does not reflect an inner scroll container's offset in this
WebView, and the criterion cannot distinguish a working scroll from a broken one: it has now been
observed identical in BOTH states. **This retroactively voids the 2026-08-26 baseline inference that
"a device swipe moved the accessibility tree by zero pixels, confirming the defect"** - that was an
insensitive instrument, not evidence. The defect's real evidence was the geometry
(`scrollHeight === clientHeight`), which was sound. The witness to use instead is CDP-read
`scrollTop` across a real `Swipe-Tool` gesture, in both directions.

**The spinner half is half-established.** With the list at the top, a full pull-down raised **no
indicator at all** (a `MutationObserver` armed before the gesture saw zero insertions, so this does
not rest on CDP round-trip timing), which is what a live socket should produce. What was NOT
independently confirmed is that the socket was in fact up at that moment: the preflight had reported
A1 `OFFLINE` ten minutes earlier, right after the fresh install, and the UI showed no offline banner
by the time of the gesture. **A declined gesture is correct while connected and a DEFECT while
offline, so "no spinner" only means what the socket state says it means.** The offline direction -
spinner present, and persisting for the reconnect rather than a fixed 600 ms - is unrun. Worth one
pass with `net.mjs` the next time the phone is on the bench; it is not what the P1 was about.

## R. The shrunk release APK actually runs - owed on Android

**Proves** that enabling `isShrinkResources` and excluding `com.google.android.material` did not
remove something the app needs at run time. **Every Android gate in this repository misses both.**
The debug build type sets `isMinifyEnabled = false`, so a debug APK never runs R8 or the resource
shrinker at all; a green `assembleUniversalRelease` proves the shrinker did not crash, never that
what survived is enough; and `androidPlayRecommendations.test.ts` reads the two settings as text and
can say nothing about either outcome. Reasoning and the evidence behind each change are on
[mobile](frontend/mobile.md#the-release-builds-shape-and-what-google-plays-analysis-asked-of-it).

Test the **release** artifact from `android.yml`, not a local build: a locally re-signed
release cannot be installed over the existing app without an uninstall, and an uninstall costs a
re-enrolment. **IT DOES NOT COST A 2FA PROMPT, AND THE SENTENCE THAT SAID SO HELD THIS CHECK UP.**
The campaign's test accounts are Authentik service accounts reached through the "Connexion externe
(service-account)" link, and they carry no second factor; 2FA is a PRODUCTION-account property
(user, 2026-09-23). A session declined to start this check on the strength of the old wording, which
is the cost of a precondition nobody re-measured. **TWO signed artifacts now exist and the RELEASE one is the target:**
v0.14.5 of 2026-08-26 carries both Android fixes and went to Google Play production, so its attached
`app-universal-release.apk` (36 MB, beside the 15 MB `.aab`) is the build users actually got - test
THAT, and note a release asset does not expire. The `workflow_dispatch` of 2026-08-27 (run
`33024610295`, signal given, green in 12m37s) is a second, LATER build off `main` with the bun
backend migration in it, and it is kept ONLY as the run artifact `android-release` (29 MB),
**which expires 2026-11-24** - so it is not a thing to plan a device pass around.

That run also PROVED the gating rather than asserting it: `Upload to Release` and `Publish to Google
Play (production)` both **skipped**, because each is `if: github.event_name == 'workflow_run'`. A
dispatch therefore attaches nothing to any release, cannot overwrite v0.14.5's assets, and ships
nothing to users. Use one only to re-check a fix made after the release was cut.

**RUN 2026-09-23 ON THE SHIPPED `v0.18.21` ARTIFACT - FIVE OF SIX PASS, AND STEP 2 IS BLOCKED ON A
FIXTURE THAT DOES NOT EXIST RATHER THAN ON A DEFECT.** Measured on the Mi 9T against
`app-universal-release.apk` taken from the release itself. **Download it BY ASSET ID**: `gh release
download` and `gh release view --json assets` both read a representation that reports zero assets
minutes after a release is cut, and a session treated that as a regression in the release it had
just shipped; `gh api repos/{owner}/{repo}/releases/{id}/assets` is the authoritative list. The
artifact talks to PRODUCTION - that is what makes it the shipped build, and why the rig's estate
guard correctly refuses to grade a campaign row on it (`pin.mjs` said so, and was right).

| Step | Verdict | The evidence, and not the impression |
| --- | --- | --- |
| 1. own background | **PASS** | The APK's own resource table declares `() #fff9fbff` / `(night) #ff070b12`, the two colours this check names, so the assertion is LOSSLESS and not a pixel judgement. A screen recording of the cold launch holds `#060a12` for the first 500 ms - `#070B12` with one LSB of h.264 chroma loss per channel - before anything else drew. No grey flash. |
| 2. a face in the shade | **OWED, no longer blocked** | The fixture exists and the path answered on the DEBUG build (`decodeSampled: 512x512 -> inSampleSize=2`, `largeIcon=true`), 2026-09-24. What is left is the same run on `bun a1apk.mjs --release`, whose install costs the device. See below. |
| 3. French channels | **PASS** | All six survive R8 WITH their descriptions: `canari_messages` "Messages Canari", `canari_mentions` "Mentions Canari", `canari_calls` "Appels Canari", `canari_social` "Activite sociale Canari", `canari_reactions` "Reactions a vos messages", `canari_forms` "Rappels de formulaires". A seventh, `default`, is named **"Default"** in English - it is `tauri-plugin-notification`'s own hardcoded literal, created on plugin load in BOTH build types, and nothing posts to it. Library blemish, not a shrinking regression ([backlog](backlog.md)). |
| 4. both system bars | **PASS** | `env(safe-area-inset-top)` = `34px`, `env(safe-area-inset-bottom)` = `24px`, left/right `0px`, with `viewport-fit=cover` intact. At `devicePixelRatio` 2.475 that is 84 and 59 physical pixels, matching the status bar and the gesture bar on screen. |
| 5. picker, dialog, biometric | **PASS, all three** | File picker: `com.android.documentsui/.picker.PickActivity` became the top resumed activity on a real touch. Dialog: a `role=dialog` rendered with its French copy and both actions. **Biometric - the one that broke before**: `ActivityTaskManager: Displayed fr.emse.canari/app.tauri.biometric.BiometricActivity for user 0: +84ms`, no `InflateException`, the system `BiometricPrompt` bound its credential view and animated in, and dismissing it rejected the promise and returned to `MainActivity` with no crash. |
| 6. refuses a device transfer | **PASS** | `aapt2` on the artifact reads `android:allowBackup=false` AND `android:dataExtractionRules=@0x7f120000`, which resolves in the resource table to `xml/data_extraction_rules -> res/4j.xml`. The shrinker RENAMED the file but kept it, which is why an `unzip | grep data_extraction` finds nothing and reads as absent. `dumpsys` on Android 16 does not print the attribute at all, so the artifact is the only witness. |

**THE FIXTURE NOW EXISTS, MEASURED ON DEBUG 2026-09-24 - WHAT IS LEFT IS THE INSTALL.** The
paragraph below said no notification the campaign can trigger carries a bitmap. That is no longer
true, and the route it named as second is the one that worked: **an association created on the LOCAL
estate, with a logo uploaded through the app's own cropper**, which writes `logoMediaId` and makes
`/api/media/public/<id>` serve real bytes (`200 image/webp`, measured). Publishing as that
association announces to the whole feed audience through `PostAnnounceScheduler`'s minute tick, and
the phone answered with the line the step requires:

```
CanariFCM: onMessageReceived: type=social ...
CanariFCM: showSimpleNotification: type=social channel=canari_social title=<the association> a publie
CanariFCM: fetchPublicMediaIcon: cached for <media id>
CanariFCM: decodeSampled: 512x512 -> inSampleSize=2, target=158
CanariFCM: showSimpleNotification: notifId=10001 channel=canari_social largeIcon=true
```

**THE RECIPE, BECAUSE A FIXTURE THAT SURVIVES ONLY IN A CHAT HISTORY IS NOT A FIXTURE.** It lives
in the estate's database and object store, so a rebuilt local estate loses it and it is rebuilt like
this, all of it through the app's own code paths:

1. `update users set admin = true where id = <the peer's>` on the local Postgres - association
   creation is global-admin or BDE `MANAGE_ASSO`, and no local account had either.
2. As that account, `/associations/new` - name and slug only; the slug derives from the name.
3. `/associations/<slug>/edit`, "Changer le logo", stage `fixtures/msg4-image.png` on the cropper's
   `input[type=file]` (`attachFiles`), then "Utiliser cette image". This is the ONLY step that
   cannot be an API call: the cropper exports a `Blob` the upload takes.
4. Check the estate, not the screen: `logoMediaId` is set, and
   `curl -o /dev/null -w '%{http_code} %{content_type}' /api/media/public/<id>` answers
   `200 image/webp`.
5. Publish as the association from that client's own page - `apiPost(cx, '/api/posts',
   { associationId, markdown })`. The announce tick is `* * * * *`, so the push follows within a
   minute; `[ANNOUNCE] post=... kind=association recipients=N` in social-service's log says it went.

**A `[NOTIFY] association <id> pushes the actor's face, not its logo` warning means the fixture is
broken, not the app** - that line separates a logo nobody uploaded from a column that cannot be
read, and neither of them measures step 2.

**That run was on the DEBUG build, so it is not check R** - `isMinifyEnabled` is false there and
nothing was shrunk. It settles the FIXTURE and nothing else: the path is reachable, the bytes are
real, and the evidence line fires. Re-running it against `bun a1apk.mjs --release` is the whole of
what step 2 has left, and that install is what costs the device.

**AND THE FIRST ROUTE NAMED BELOW IS NOT AVAILABLE AT ALL.** "Giving a test account an avatar
server-side" cannot be done on any estate here: `users` has no avatar column, and
`/api/mls/push/avatar/:id` proxies core-service's `users/:id/avatar`, which fetches from
**MiGallery** - another repository's estate, keyed by the school's own photo directory. An account
without a photo there returns `absent`, and writing one is not a change this repository can make.
The association-logo caller is the only feeder a fixture can reach.

**WHY STEP 2 COULD NOT BE MEASURED ON 2026-09-23, AND WHAT UNBLOCKED IT.** The step needs a notification
carrying a real bitmap, because `decodeSampled` is the line that separates "the avatar arrived" from
"the fallback looked fine". Its ONLY feeder is `cachedRemoteIcon`, which has exactly two callers: a
user avatar and an association logo. **No test identity on any estate has an avatar image** - the
app renders initials for them - and **the frontend exposes no user-avatar upload anywhere**: every
`input[type=file]` in it belongs to association documents, the association logo cropper, a calendar
event, the chat composer, the form builder, post create/edit, the settings backup or the community
admin panel. So no notification the campaign is able to trigger can carry a bitmap, and the log line
is unreachable by construction. The association-logo path is reachable only by posting AS an
association on production, which publishes to real students and is therefore not a test. **Unblocking
it means giving a test account an avatar server-side**, or setting a logo on a test association on
the LOCAL estate and running step 2 against a release-configured APK built for that estate - the
minification is identical, so it measures the same R8 output ([backlog](backlog.md)).

**THE P1 THIS RUN FOUND - AND THE READING THAT LOOKED LIKE ITS PROOF AND WAS NOT.** The shipped
`v0.18.21` library compiles `setWebContentsDebuggingEnabled`, because the `devtools` Cargo feature
sat in plain `[dependencies]` and wry gates that call as
`#[cfg(any(debug_assertions, feature = "devtools"))]`; `tauri.conf.json` supplies its argument as
`true`. On an ordinary phone that is an inspectable WebView, and with it the MLS state, decrypted
message content and the access token the repository's rule keeps in memory *precisely* because
memory is supposed to be unreachable. **`open_devtools()` at `src/lib.rs` is correctly
`#[cfg(debug_assertions)]`-gated, which is why auditing that call site clears a release that is not
clear** - nothing opens a panel, and that was never the security property. The feature is removed in
`0.18.22`.

**THE PROOF IS THE BINARY, AND THE PHONE IS DISQUALIFIED FROM GIVING ONE.** `strings | grep -c` on
`lib/arm64-v8a/libmines_app_lib.so`: **1 in the shipped `v0.18.21` artifact, 0 in the new build**,
same architecture, same release profile, and 0 in `classes.dex` too. The runtime probe cannot
corroborate either half, and the reason is a property of the test device rather than of the app:
**the Mi 9T reports `ro.build.type=userdebug`, a ROM that enables WebView debugging for every
application on it.** Measured, not assumed - the new APK, which provably contains no enabler
anywhere, still opened `@webview_devtools_remote_<pid>` for its own pid. So the 2026-09-23 reading
that first raised this was TRUE and EMPTY: it would have appeared whatever the artifact contained.
**What is owed is the same `/proc/net/unix` probe on a `user`-build device**, which is the only kind
that can tell an app's own setting from the ROM's.

1. **The app starts on its own background, not grey.** `windowBackground` is now
   `@color/app_background`, so the gap before SvelteKit hydrates is `#070B12` dark / `#F9FBFF` light
   - the colour the page settles on, where it used to be the parent theme's `colorBackground`.
2. **A notification with a face still shows the face.** This is the only path that decodes an image,
   so a stripped class or resource surfaces here as the initials disc. Require both: a face in the
   shade, and `decodeSampled: <W>x<H> -> inSampleSize=<n>, target=<t>` in logcat - the log line is
   what separates "the avatar arrived" from "the fallback looked fine".
3. **The notification channels are still named in French.** Strings are the resources most exposed
   to shrinking, and a stripped `values/strings.xml` entry is invisible until someone opens the
   app's notification settings.
4. **The two system bars still have their gap.** The theme parent changed, so re-read
   `env(safe-area-inset-top)` and `env(safe-area-inset-bottom)` through CDP and require non-zero,
   as measured on 2026-08-07.
5. **A file picker, a dialog, AND THE BIOMETRIC PROMPT still open.** The claim under test is that
   nothing referenced the excluded library. **This step said "the only native UI this app has" and
   named two of three** - and the one it left out is the one that broke: `app.tauri.biometric`'s
   `auth_activity.xml` inflates an `androidx.coordinatorlayout` root that only
   `com.google.android.material` was carrying, so every biometric call died in the inflater. An
   enumeration of native UI is a claim about the whole app and must be derived from the LAYOUTS the
   dependencies ship, never from the Kotlin this repo wrote - a layout is a reference no source grep
   sees. Google Play reported the same crash from the field on versionCode 14005 on 2026-08-27,
   which is what [the vitals watch](../../tools/play-vitals/README.md) now reads.
6. **The installed package refuses a device transfer.** `adb shell dumpsys package fr.emse.canari`
   must show `dataExtractionRules` resolved, not just `allowBackup=false` - the attribute that does
   NOT cover device-to-device transfer on Android 12+. Asserting the merged manifest is what the
   build already proves; this asserts the artifact Play will actually ship.

**A debug pass covers none of this**, which is why this check is separate from Q - cleared on a
debug APK on 2026-08-26, on a build that by definition never ran R8.

## S. An iPhone obtaining a push token at all - RUN 2026-08-28, split verdict

**Proves** that the ordering fix of 2026-08-28 works, and it is the only thing that can: the call it
replaced compiled perfectly and could never succeed, so a green iOS build says nothing here.
Measured 2026-08-27, `push_token` held 49 `android` rows and had **never** held one `ios` row - no
alert, no mention and no CallKit ring had ever reached an iPhone. Mechanism on
[mobile](frontend/mobile.md#the-fcm-token-an-iphone-could-never-obtain-and-the-silence-that-hid-it-for-the-platforms-life).

**Steps.** Install the TestFlight build of 0.14.8 or later on the iPhone, sign in, and put the app in
the foreground once - `didBecomeActive` is the trigger, so a launch is enough. Then, from this
machine:

```
<ssh to the host> 'docker exec <prod postgres container> psql -U <db user> -d <db> -c "SELECT platform, count(*) FROM push_token GROUP BY platform"'
<ssh to the host> 'docker logs --since 30m <chat-delivery container> 2>&1 | grep PUSH_UNAVAILABLE'
```

**PASS** = an `ios` row exists. Then send the iPhone a message from another device with the app
killed, and confirm the alert arrives: the row proves registration, not delivery.

**A `[PUSH_UNAVAILABLE] ... platform=ios reason=no-token` line is NOT a pass, but it is not a
regression either** - it is the first time the platform has reported anything, and it says the
ordering was not the only broken link. The candidates left, and the device log that separates them,
are in [backlog](backlog.md) under the P1; `[CanariPush] APNs token not here yet` versus
`[CanariPush] FCM token synchronised` names the branch, and reading it needs `idevicesyslog` or a Mac.

**Neither answer arriving means the build did not reach the phone.** Check the version the device
runs before reading anything into the silence - TestFlight is the beta channel and an ordinary
install is not automatic.

### The run of 2026-08-28, 01:23 Paris - what it settled and what it did not

**Conditions, which matter because the first attempt was worthless.** A tester uninstalled and
reinstalled 0.14.8 from TestFlight (`REGISTER_DEVICE ... isNew=true` at 01:14:45, a device id never
seen before), in a window with no CD deploy running. An earlier attempt the same night was void:
five CD deploys landed between 00:40 and 00:52 and each restarts every container, so the logs that
would have carried a report were destroyed as they were written. **A hardware check and a push to
`main` are mutually exclusive, exactly as a campaign run is.**

**The half that PASSES.** At 01:23:39 the server printed, for the first time in the platform's life:

```
[PUSH_UNAVAILABLE] user=0acc3ab9... device=tauri-0acc3ab9...-mtc545la-ebnu platform=ios reason=no-token
```

The client classified its own failure, the server printed it unrewritten, and one `GROUP BY` now
answers a question that previously took a CORS incident to stumble into. The instrumentation is
verified on hardware, which is the only way it could be.

**The half that FAILS.** `reason=no-token` means `getFcmToken()` read nothing for four minutes:
the OS never handed this app an FCM token. **The ordering fix was necessary and is not sufficient** -
`push_token` still holds `android | 49` and no `ios` row.

**One inference made during the run and RETRACTED, recorded so it is not made again.** The device
reconnected its WebSocket 12 times in 15 minutes, each reconnection paired with a `REGISTER_DEVICE`,
and that was read as a full client re-initialisation which would reset the module-level
`pushAttempted` and prevent the four-minute ladder from ever completing. **It did complete**: the
ladder that reported started around 01:19:39 and ran straight through the events at 01:20:10,
01:21:36 and 01:22:36. So those events are socket and device-registration churn, not a teardown of
the JS context, and the module state survives them. Android shows the same churn (7 in 10 minutes).
Whether the churn itself is a defect is a separate question and is not evidence about push.

**What the next run must separate, and why it needed a build.** `reason=no-token` cannot say
WHETHER AN APNs TOKEN EVER ARRIVED, which is the fork the two candidates hung on. That fact is known
on the device and was written only to a console this machine cannot open.

#### The cause was then found without another run, and the re-run is what closes this

**Read the order, 2026-08-28.** `FIRMessaging.APNSToken` is set only by
`application:didRegisterForRemoteNotificationsWithDeviceToken:`, this app does not own its
`UIApplicationDelegate` (wry installs one inside `ffi::start_app()`), and Firebase's App Delegate
Proxy - the declared bridge - samples `sharedApplication.delegate` exactly once, at
`[FIRApp configure]`, which runs from `main()` before the application exists. It found nil and never
retried, so the APNs token had nowhere to land on every launch the platform has ever had. Full
account on
[mobile](frontend/mobile.md#the-apns-token-had-nowhere-to-land-because-the-proxy-meant-to-catch-it-installed-nothing).

**The re-run is therefore the proof, and it is worth stating what each outcome means** - everything
native here is verified by compiling, which proves nothing about running.

- An `ios` row in `push_token` closes the P1 outright.
- Another `[PUSH_UNAVAILABLE]` is no longer ambiguous: the reason now names which branch failed -
  `no-apns-token` (APNs still never answered, so look at entitlements, provisioning and the
  notification permission), `fcm-token-fetch-failed` (APNs answered and FCM refused),
  `apns-registration-refused` (the OS refused registration, a branch that previously had no observer
  at all) or `app-delegate-absent`. **None of the four is the cause just fixed**, so a repeat of
  `no-token` itself would mean the hook did not install and the log line
  `[CanariPush] APNs token hook installed on ...` is the thing to ask for.
- Run it in a QUIET WINDOW. The first attempt of 2026-08-28 was voided by five CD deploys in twelve
  minutes: a push to `main` restarts every container and destroys its logs, so a hardware check and a
  push are mutually exclusive, exactly as a campaign run is.

## T. The redirect URI an iOS build asks Authentik for - owed on iOS

**Proves** the fix for App Review's rejection of 2026-08-30 under guideline 2.1(a). **Precondition:**
a build carrying `tauri-plugin-os`; on anything older the check measures the defect, not the fix.

1. Fresh launch, then tap **Sign in**.
2. **The verdict is one log line**: `login returnTo=/chat uri=fr.emse.canari://callback`. Any `uri=`
   containing `tauri://localhost` is a FAIL and is exactly what App Review saw.
3. The login page must arrive in an `ASWebAuthenticationSession` sheet - it carries a Done button and
   names the `auth.canari-emse.fr` host above the page. The app's own view navigating to Authentik is
   the same FAIL wearing different clothes: it is the other half of the branch step 2 measures.
4. Finish the login. `/auth/callback` runs and the conversation list appears.

**Server-side, for a verdict that does not depend on reading the client's log:**
`<ssh to the host> 'docker logs <miconnect server container> --since 10m 2>&1 | grep -a authorize | tail -3'`
prints the request Authentik actually received - its `redirect_uri`, its `status` and the client's
`user_agent`.

**An iPhone settles this check for the iPad**, which is the one place in this file where hardware we
do not own is not owed a run of its own: `platform()` is a constant compiled into the iOS target, and
the iPad's only difference - its user agent - is no longer read by anything
([mobile](frontend/mobile.md#the-ipad-that-called-itself-a-macintosh-and-the-login-app-review-could-not-finish)).
It settles NOTHING about iPad layout, which nothing here has ever measured.

## U. The biometric cadence: every 12 h skips the sheet, every time keeps it - owed on BOTH platforms

**Proves** the cadence ([auth](frontend/modules/auth.md#how-often-the-sheet-comes-back---the-biometric-cadence-2026-09-28)).
**Precondition:** a build carrying `getKeyBytesUnattended`, biometrics enabled. Check G still holds
as written: enabling records no proof, so its first relaunch prompts under either cadence.

1. Default cadence (Settings > Security shows **Every 12 h** selected). Cold launch: the sheet
   appears, unlock. Expect `[BIOMETRIC] Prompt due (cadence=every_12h, lastPrompted=never)`.
2. Kill and relaunch within 12 h: **no sheet at all** - neither the OS prompt nor the in-app
   `BiometricBottomSheet` - and the conversation list appears. Expect `Prompt skipped` and, native
   side, `retrieve_device_key: unattended read (no biometric sheet)`. Check G's step 4 (messages
   persist) must hold on this session too: the key reached the frontend the same way.
3. Switch to **Every time**, kill, relaunch: the sheet is back on EVERY launch. On iOS this is the
   property the user most wanted kept - the read is `getKeyBytes`, the `.userPresence` item.
4. Back to **Every 12 h**, turn biometrics off then on: the cadence radio keeps **Every 12 h**, and
   the next launch prompts (forgetting dropped the proof).
5. From the PIN modal (cancel the sheet once), tap **use biometrics** while inside the window: the
   sheet MUST appear - that button never reads unattended.

**Android, Mi 9T, `c8e572070` against the local estate (2026-09-28): the cadence decisions all hold,
step 5 does not - and the defect behind it predates the cadence.** The phone has no enrolled finger,
so a PROMPTED read ends in `Authentication error: 11` and the PIN modal; the proof was seeded through
CDP (`canari_biometric_last_prompted_unlock_at`) rather than written by a real success, and the
Settings radio was not driven. Measured:

| Case | Log | Verdict |
| --- | --- | --- |
| no proof, every 12 h | `Prompt due (cadence=every_12h, lastPrompted=never)`, `getKeyBytes` | due, prompted |
| proof 1 min old | `Prompt skipped`, `unattended read (no biometric sheet)`, `getKeyBytesUnattended`, `MLS ready` | no sheet, list decrypted, 0 `Failed to decrypt SQLite` |
| message sent in that session, cold relaunch | same skipped path | the message is still there - the key wrote AND read the store |
| every time, proof 6 min old | `Prompt due (cadence=every_launch, ...)`, `getKeyBytes` | due, prompted |
| proof 13 h old | `Prompt due (... lastPrompted=780 min ago)` | due |
| proof 60 min in the FUTURE (clock set back) | `Prompt due (... lastPrompted=-60 min ago)` | due |
| step 5: the modal's button, fresh proof | `unattended=false`, then `[BIOMETRIC] Failed - no local user found.` | **FAILED**: never reached the keystore |
| step 5 again, on the fix (same day, uncommitted diff `112e8236036d` on `3d25f2d76`) | `unattended=false`, `getKeyBytes`, `keystore_empty` read off the typed code, 0 `Unrecognised state-load failure` | prompted - the sheet would appear |
| proof 1 min old, on the fix | same skipped path, `MLS ready` | no regression |

**Step 5 failed because a failed launch unlock forgot who the user is.** The catch of `loginImpl`
called `clearUserLocally()` on every failure, `keystore_empty` included, so the button that follows
found `currentUserId()` null and stopped before any read - with an English, non-Paraglide error.
Fixed the same day and shipped in `v0.18.28`: the catch forgets the identity on
`SessionExpiredError` only (a revoked device is already forgotten by `wipeRevokedDevice`), `mls-core`
throws a typed `KEYSTORE_KEY_UNAVAILABLE` instead of the sentence two call sites matched by regex,
and the English error became `auth_biometric_no_user`.
Still owed: a real finger (the proof written by a success), the Settings radio (step 4), and all of
iOS.

## V. The camera swipe on a fresh Feed after publishing - owed on Android

**Proves** [the modal that left the overlay stack](frontend/mobile.md#a-modal-closed-by-its-owners-state-left-the-overlay-stack-and-the-tab-swipe-stood-down-2026-10-09).
**Precondition:** a build carrying it, the Mi 9T, a signed-in account that may publish.

1. Open the Feed, publish a post from the composer (the modal closes by itself).
2. Immediately, with no other navigation, swipe right from the Feed: the camera must open, first time.
3. Repeat three times. The failure was 3 of 3 on the first load after publishing.

A refusal here means some OTHER overlay is still registered: read `historyOverlayStackDepth()` over CDP.

**`PASS` on the Mi 9T, `v1.2.6-alpha.1`, 2026-10-13, 4 of 4.** A post typed and published from the
header's "Publier" (the modal closed by itself 658-1099 ms after the click), then at once one
`adb input swipe 200 1200 1000 1200 180`: `/camera` every time. The swipe is injected, not a finger;
the same swipe opens the camera from a feed nobody published on. The bench posts were deleted
afterwards. Evidence: `<harness-dir>/a1-bench/r1013-owed/checkV*.json` and frames.

## iPad and rotation - owed on an iPad\n\nSwitching into Canari from another app does not rotate the window on an iPad (reported 2026-08-28); it needs an iPad. The Android phone rotation is decided and shipped: portrait under 600 dp, free on a tablet (`canari_lock_portrait`, [mobile](frontend/mobile.md#the-window-layout-the-keyboard-and-the-orientation-lock)).\n

## X. The scroll after an edge swipe - owed on the Mi 9T

**Proves or refutes** [the swallowed scroll](frontend/design-reference.md#41-the-system-back-gesture-takes-the-edge-touch-and-the-swipe-back-stayed-armed-mi-9t-2026-10-05):
adb-injected edge gestures may not behave as a finger, so this is a REAL-FINGER reading. **Precondition:**
a build carrying the `[swipeBack]` lines, gesture navigation on, a conversation with enough messages to scroll,
the page inspectable over CDP (console) or `logcat`.

1. Open the conversation, tap the text field, close the keyboard with the system back swipe from the
   left edge. Expect `[swipeBack] armed at x=<small>` then `[swipeBack] touch cancelled (tracking=true...)`
   and the conversation STILL open.
2. Immediately scroll the list from mid-screen with one finger. Does it move on the FIRST stroke?
3. Repeat the edge swipe, wait 3 s, then scroll. Then repeat with a scroll from the edge strip itself.
4. If the first stroke is swallowed with a `cancelled` line before it: it is the engine after a cancelled
   sequence, and the question moves to the WebView (record it, do not patch the page). If it is swallowed
   with NO `cancelled` line: the edge touch was not seen by the page at all.

## W. The composer stands still while the keyboard rises - owed on BOTH phones

**Proves** [the two stale numbers of a keyboard rise](frontend/modules/chat.md#every-keyboard-rise-moves-the-composer-for-a-moment-on-both-phones-measured-2026-10-02-fixed-2026-10-09-reading-owed).
Method of the original reading (#1345): over CDP, sample the composer's top
(`.chat-composer-footer`, `getBoundingClientRect().top`) every animation frame while tapping the
text field of an open conversation.

1. **Mi 9T**: the top goes from ~877 straight to ~532, with NO frame near 174 (it sat there 60-100 ms),
   and `visualViewport.height` never reads below `innerHeight` by a keyboard's worth.
2. **iPhone 12**: the top goes from 766 straight to ~487 pt, with NO ~400 ms plateau at 465, and the
   closed composer is where it always was (the pin is released on close).
3. Open and close the keyboard five times each: no frame outside the two resting positions.

**iPhone 12, `v1.2.3-alpha.5`, 2026-10-11: `FAIL` in a new shape, 3 of 3 rises.** The store build is
not inspectable, so the composer was read from WDA's MJPEG stream (~22 frames/s, a frame every 45 ms).
Step 2 holds: the composer goes from 766 to 487 pt with no plateau at 465, and a close goes back to
766 in one frame. Step 3 fails. The native "+" twin is at 487 in the first frame of the rise. The web
layer is not: for five or six frames (~250 ms) it is drawn about one keyboard height LOWER, then it
slides up. The web composer is hidden behind the rising keyboard, the "+" floats alone, and the dev
banner slides from y=333-353 pt up over the glass header. In points per frame: banner
333/282/204/117/72/60, composer 713/642/592/546/501/487. Frames:
`<harness-dir>/ios-bench/r1011/kbd2`, `kbd3`, and the contact sheets
`kbd2-contact*.png`.

**Mi 9T, `v1.2.6-alpha.1`, 2026-10-13: `PASS` with the system keyboard (AOSP LatinIME), 5 of 5
rises and 5 of 5 closes.** The composer's top goes from 869.5 straight to 524 CSS px in one frame
and back to 869.5 in one frame on close; no frame near 174 and no other resting position. The raw
double report is still there underneath: in 4 of 5 rises ONE frame reads `visualViewport.height`
230.3 against an `innerHeight` already at 588 (945 - 2 x 357), so step 1's second clause, read
literally, fails - and `computeSnapshot` absorbs it, which is the fix this check proves.
**A short keyboard escapes that guard.** The bench's ADB keyboard is 90 px tall, under the 160 px
`keyboardOpenThresholdPx`, so `layoutGaveUpKeyboard` is false and the double report is trusted: in
2 of 5 rises the composer spends one frame (~60 ms) at 702.1 before resting at 791.8, and in the
other 3 it spends 24 ms at 881.5. No real IME on this phone is that short; a floating or
one-row keyboard would be. Evidence: `<harness-dir>/a1-bench/r1013-owed/checkW-mi9t.json`
(the LatinIME run; the ADB-keyboard numbers above are the only record of that run).

**Two more steps, owed on the Mi 9T on the first build carrying the fix of 2026-10-29**
([the field that stays focused](frontend/modules/chat.md#a-field-that-stays-focused-with-the-keyboard-down-the-rise-that-covered-the-thread-and-the--that-raised-the-keyboard-2026-10-29)):

4. Open the keyboard in a long DM, put it away with Back, scroll up ~150-300 px, tap the text field:
   the thread goes to its last message above the composer (`[ChatArea] keyboard opened:
   follow-bottom`); on `1.5.1-alpha.7` it stayed put and the keyboard covered 345 px of it.
5. Open the keyboard, put it away with Back, tap "+": the menu, and NO keyboard. Then tap the field
   and "+" again: the menu over the keyboard, the keyboard still up.

## DT. A double tap likes a post - owed on BOTH phones

**Proves** [the double tap that likes](frontend/modules/posts.md#a-double-tap-likes-the-post-and-never-unlikes-it-2026-10-19)
on real fingers: every gate here dispatches synthetic `click`s, so whether WebKit and the Android
WebView deliver the two taps as two clicks with a `detail`, and nothing else, is read here only.
**Precondition:** a build carrying `doubleTapLike`, a bench account, a feed holding a text post, a
photo post, a poll post and a reel, none of them reacted to by the account; the console (CDP on the
Mi 9T, the in-app log on the iPhone) for the `[doubleTapLike] double tap` and
`[PostCard.doubleTap]` / `[reel-viewer] double tap` lines.

**When a double tap does NOT like, read what reached the page before suspecting anything** (DT-IOS,
2026-10-21: a native XCUITest double tap never liked on the iPhone, real W3C two-tap sequences did).
Each tap of the gesture logs `[doubleTapLike] press ended (touch)` and then `[doubleTapLike] click
(detail N, surface|opener|owned)`; a sequence under way that ended logs `sequence ended: <why>`.
Two `press ended` with no `click` after them is the engine's own double-tap recognizer swallowing
both clicks - the one case worth a detector change, and only once it is seen with a finger. No
`press ended` at all means the touches never reached the card (another layer took them).

1. **A reel, in the viewer**: open it, double tap the picture. Expect the heart at the finger, one
   `like` line, the controls ending as they started, the video still playing. Double tap again: the
   heart, an `already reacted, heart only` line, no request. Close: the card shows ❤️ as the reader's
   reaction. Single tap: the controls toggle AT ONCE (no wait).
2. **A reel card in the feed**: double tap it - liked, and the viewer does NOT open. Single tap it -
   the viewer opens after a beat (~250 ms) and, if sound was turned on in the app, plays WITH sound
   (the held tap is replayed from a timer: the user-activation question is the one thing reasoned
   rather than measured).
3. **A photo post**: double tap the picture - liked, no lightbox. Single tap - the lightbox opens.
4. **A text post**: double tap the text - liked, no word selected, the page did not zoom or slide
   to a neighbouring tab. A long press still selects the text.
5. **A poll option**: double tap an option - it votes / unvotes as two taps always did, and the post
   is NOT liked (no heart, no line).
6. **VoiceOver (iPhone) and TalkBack (Mi 9T) on**: the reaction button still likes ("Ajouter une
   réaction", then the heart in the picker); activating a photo opens the lightbox at once (no held tap); activating anything never
   likes the post. A two-finger or three-finger screen-reader gesture over a card likes nothing.
7. **Haptic**: the Mi 9T ticks on a like with vibrations on in the settings, and not with them off.
   The iPhone has no web vibration and is expected to stay still.

## Y. Watching a live - owed on BOTH phones (Mi 9T, iPhone 12)

**Proves** [the live viewer](frontend/modules/live.md#the-viewer-as-built-2026-10-19) in the app's
own WebViews, which no gate here runs: the tests drive fake MSE objects, and WP-L1 measured the
bench page, not this player. **Precondition:** a build carrying the viewer (`LIVE_ENABLED` is on
in every build since 2026-10-30; a dev pre-release until a stable carries it), a broadcaster sealing segments in [format v1](frontend/modules/live.md#the-segment-seal-format-v1)
(the app's own broadcaster on the other phone - run with [LIVE-B1](#live-b1-the-broadcaster-on-both-bench-phones---owed-on-both);
the WP-L1 bench's own `live-bench` seal reads "Live indisponible" here, by design), and the console over CDP or the WebKit bridge for the `[LIVE]` lines.

1. **Watch from the other phone.** Start a live on phone A; on phone B open the Feed: the LIVE card is
   at the top, naming A. Tap it: `[LIVE] viewer joined <id> at segment N`, then picture and sound
   (after one tap on the sound button), the LIVE badge and the time on air counting. Read
   glass-to-glass against WP-L1's 5.8-7.3 s p50 (clap in front of A's camera), expecting about 3 s
   more behind a Mi 9T that delivers in pairs. **The [buffer policy](frontend/modules/live.md#the-buffer-policy-l-f1-2026-10-27)
   (L-F1)**: watch two minutes with the Mi 9T as A; past the first delivery gap there is NO
   `stalled at` line and no run of `seek to the live edge (stall)`, and `waiting while seeking` lines
   are allowed (each is a seek's own wait). Record the `target buffer now N ms` the viewer settled on.
2. **Kill the network** on B for 20 s (airplane mode): "Reconnexion..." within a few polls, never
   "Live complet". Back online: `seek to the live edge (catch-up)` and the picture at the edge, not
   replaying the gap. Then kill A's network for 20 s: B says "Le live est interrompu, il devrait
   reprendre." and comes back by itself when A does.
3. **Rejoin**: close the viewer (X, then Android Back on a second try), reopen from the card. The
   server's seat count must not grow (`DELETE /api/lives/:id/seat` in the access log on close).
4. **The cap**: on dev, lower `LIVE_VIEWER_CAP` to 1 for the reading (an operator change on the dev
   estate, put back afterwards), watch from a browser, then open on B: "Live complet" with "Réessayer";
   close the browser viewer, tap "Réessayer" on B: it plays.
5. **Background and foreground** B for 10 s, then 40 s (past the 30 s seat lease): it comes back to
   the live edge, or to "Live complet" if the seat was taken meanwhile - never a frozen frame.
6. **The end**: end the live on A: B reads "Le live est terminé" within about a second, the video
   stops, and no further `[LIVE]` poll line follows.

Record per phone: the engine's MSE flavour (`MediaSource` on the Mi 9T, `ManagedMediaSource` on the
iPhone), any `append failed` or `did not open` line, and whether `endstreaming` from
`ManagedMediaSource` (ignored in v1) left the iPhone starved.

## VQ. Call video at 720p and its quality ladder - owed on BOTH phones (Mi 9T, iPhone 12)

**Proves** [the quality ladder](frontend/modules/calls.md#the-quality-ladder-2026-10-21---720p-and-an-automatic-drop)
where no gate here can: what a 720p VP8 encode COSTS a phone (CPU, heat, battery) and whether the
ladder drops on a real weak link and climbs back. The desktop rig measured only Chrome on a desktop
CPU, on loopback. **Precondition:** a dev pre-release carrying the ladder, a bench account on each
phone and a desktop profile (`bun tools/cross-client-harness/callpeer.mjs`), the phone screen kept on,
the phone at room temperature and above 50 % battery, unplugged during the heat runs (a charger heats it).
The procedure, the commands and the order are on the calls page, section "Measuring it on the
phones"; record each run's numbers in [device-readings-2026-10](device-readings-2026-10.md).

1. **The climb**: a video call from the desktop on a good Wi-Fi. Record the capture size the phone
   logs at the camera's opening (`[Call] camera captures WxH at F fps` - 720x1280 or 1280x720), that
   the ladder logged `starts on 480p30 (degradationPreference=unset)` and NOT
   `video quality ladder not started`. Within ~10 s the phone's log reads
   `video quality up 480p30 -> 720p30`, and `callpeer` prints the phone's picture at 1280x720 (or
   720x1280), ~30 fps, freezes 0. A call that goes through the TURN relay (the path line says
   `relay`) stays at `480p30` by design and is not a failed climb.
2. **The cost, 5 minutes per rung**: the CPU of the app's processes, the temperature and the battery
   drain at 720p, then at 480p (the calls page says how to hold a rung). The verdict is a number per
   rung, compared with an AUDIO call of the same length on the same phone.
3. **The drop**: throttle the phone's link (procedure on the calls page) during a call: a
   `video quality down` line within ~4 s of the throttle, naming its evidence; the screen shows "Votre
   vidéo est envoyée en qualité réduite" once the ladder is at 360p15 or below; the call never freezes
   for longer than the drop. Lift the throttle: the ladder climbs back one rung per ~8 s.
4. **The CPU drop**: on the iPhone, where VP8 is software only, read `limit=` on the
   `video ... send=` line through a 5-minute 720p call: a `video quality down ... limit=cpu ... enc=NN%`
   line is the iPhone saying 720p is too much (the ladder drops on `cpu` only with the encoder busy
   half the time), and the reading records it; after such a drop, the ladder must hold the lower rung
   rather than walk further down while `limit=cpu` lingers.

## CR. The composer's camera films a CanaReel - owed on BOTH phones

**Proves** [one camera, one behaviour](frontend/modules/reels.md#the-two-ways-into-the-camera-publish-the-same-thing-2026-10-19)
on real hardware: every gate here replaces the camera, the recorder and the server, so whether the
overlay, the publish step and the composer's modal hand over cleanly (history entries, the native
chrome on iOS, the keyboard) is read here only. **Precondition:** a pre-release carrying it, a bench
account, the console (CDP on the Mi 9T, the in-app log on the iPhone) for the `[reel-capture]`,
`[reel-publish]` and `[POST_COMPOSER]` lines.

1. **"+" -> new post**, type a line of text, "Ouvrir la caméra", HOLD the shutter ~3 s. Expect the
   review, then "Suivant" opens "Nouveau CanaReel" with the amber line "CanaReel : supprimé au bout
   de 30 jours..." ABOVE the identity, and the text as the caption.
2. **"Publier"**: the toast "CanaReel publié", the camera AND the composer gone, the feed under it
   showing the reel as a 9:16 card that opens the reel viewer. Reopen "+": the text is NOT offered
   again. The server row is `kind='reel'` with `durationMs` (the same as a reel filmed from the tab).
3. **Again, but "Garder comme post"**: back in the composer with the video attached and the text
   intact; "Publier" makes an ordinary post (the file's ratio, the media viewer).
4. **A TAP in the composer's camera** (a photo): "Ajouter" attaches it to the composer, no publish step.
5. **"Photo/vidéo" -> a gallery video**: attached to the composer, published as a post, never a reel.
6. **Edit an existing post -> its camera -> HOLD**: "Ajouter" attaches the video; no publish step.
7. **Back / the edge swipe** from the publish step returns to the take, a second one asks to discard
   it, a third closes the camera onto the composer (iPhone: the native tab bar and chrome stay hidden
   while the camera is up).
8. **Back DURING the upload** (a 60 s take on a throttled network, on the tab AND from "+"): nothing
   happens, the back arrow is greyed, `Back refused: the publish is past its upload` in the log, and
   ONE reel appears. The screen reader (VoiceOver / TalkBack) reads the 30-day notice first when the
   step opens from "+".
9. **A poll (or a schedule) switched on in the new post, then the camera, HOLD**: "Ajouter" attaches
   the video to that post; no publish step. "Garder comme post" after editing the caption and
   choosing "Anonyme" in the step: the composer shows the edited text and "Anonyme"; publishing it
   lands on the "Tout" feed.

## RR. The CanaReels rail, the comments sheet and the photo pages - owed on BOTH phones

**Proves** [the rail, the sheet and the photo pages](frontend/modules/reels.md#the-rail-the-comments-sheet-and-the-photo-pages-user-2026-10-19-instagrams-reels)
on real fingers and a real keyboard: every gate here is jsdom, which has no layout, no keyboard
and no WebView. **Precondition:** a build carrying `ReelActionRail` against a social-service
carrying `singlePhotos`, a bench account, at least two reels and one post of exactly one photo;
the console (CDP on the Mi 9T, the in-app log on the iPhone) for the `[reel-viewer]` and
`[reel-comments]` lines.

1. **The rail**: open CanaReels. Expect heart, comments and send bottom-right over every page, with
   their numbers, clear of the caption and of the player's bar, at 1x and at 200 % text.
2. **The heart**: tap it - filled, the count +1, one `heart ... like` line; tap again - empty, a
   `take back` line. A double tap on the rail likes nothing more (no burst at the finger). On a
   post the account reacted to with 😂 (from the card's picker), the rail shows 😂, not a heart.
   Two fast taps on a slow network send one request (`in flight, ignored` line).
   The comments number matches the card's on a post of more than twenty comments.
3. **The sheet**: tap comments - the sheet rises over the lower ~60 %, the reel keeps playing above.
   Type a comment: the keyboard does not cover the field. Send it; close the viewer - the card shows
   it. Close the sheet each way: drag the grabber down, Back (the viewer stays open), tap the reel
   above, the X. A swipe over the list scrolls it and does not close the sheet.
4. **Report a comment from the sheet**: the reason dialog is drawn ABOVE the viewer.
5. **Send**: a toast says the link is copied; the clipboard holds `/posts/<id>`.
6. **Photo pages**: the one-photo post appears among the reels as a page, its picture whole, no
   player bar, the caption lower, the same rail. A post of two photos never appears.
7. **VoiceOver / TalkBack**: the rail reads "J'aime, N réactions", "Commentaires, N commentaires",
   "Partager"; the sheet takes the focus on open and gives it back to the comments button on close.
8. **Desktop wheel** (a browser on a desktop, a mouse, then a trackpad): one wheel notch down is
   the next reel, up the previous; a hard spin of a free-spinning wheel and a trackpad flick each
   turn ONE page (`[reel-viewer] wheel` once per gesture); ctrl+wheel zooms the page and does not
   turn it; with the comments sheet open the wheel scrolls the list; over an unfolded caption it
   scrolls the caption.

## The iPhone 12 owed-readings inventory (2026-10-11)

Every reading the wiki, the backlog, `CLAUDE.md` and the pull requests of 2026-10-09 to 2026-10-11
owe the iPhone, classified against the build on the bench that day: TestFlight `1.2.3 (100200305)`,
which is `v1.2.3-alpha.5`, signed *TestFlight Beta Distribution* (aps `production`, no
`get-task-allow`, so NOT inspectable and no app log in the syslog), on `dev.canari-emse.fr`, signed
in through "Connexion externe (service-account)" as `canari-test-gamma`. Driven with
`tools/ios-device/ios.mjs` over WDA, timed from WDA's MJPEG stream on port 9100. Evidence:
`<harness-dir>/ios-bench/r1011/`. **Delete a row when its reading is taken on
the build it names.**

| Reading owed | Source | Status on 2026-10-11 |
| --- | --- | --- |
| #1370 camera letterbox: 20+ opens, both lenses, a home-and-return | backlog verification table | **`PASS` front lens, rear NOT READ.** 22 opens, 8 lens flips, 2 home-and-returns: every front-lens preview full-bleed (0 dark columns, 3 dark rows: the status band). The rear lens faced the table, so its frame was black, with the torch button drawn. Owed: the rear half with the phone held up |
| #1605 "Ouvrir dans l'application" on the login page | backlog | **`PASS` (iPhone half).** `canari.emse.fr/login` in Safari shows the link (dev correctly has none: `MOBILE_APP_LINK_HOSTS`), Safari asks "Ouvrir dans Canari ?", the app comes up on `/chat`. Android half still owed |
| Liquid glass chrome: alignment, keyboard, "+" > Photos, the four names | backlog, the Liquid Glass section | **alignment, picker and names `PASS`**: back, title pill and menu share one centre line, and the pill is centred at x=195. "+" opens Photothèque / Appareil photo / Tous les fichiers / Envoyer un GIF, and Photothèque opens ONE system picker. The AX names (the ones VoiceOver speaks): "Retour au menu", "Paramètres du groupe", "Plus d'actions", "Ajouter". **Keyboard: see W** |
| W, the composer during a keyboard rise | check W | **`FAIL`, new shape**: [W above](#w-the-composer-stands-still-while-the-keyboard-rises---owed-on-both-phones) |
| Emoji rows 1, 3, 12 (the iPhone, where the font never drew) | [emoji](frontend/emoji.md#what-a-future-campaign-owes---the-twelve-rows-moved-from-the-backlog-2026-10-08) | **`PASS` by eye, in part**: a flag, a ZWJ family and a skin-toned thumb are ONE picture each in the composer, with the caret after them. One Backspace removes the toned thumb whole. The sent bubble draws the flag and the family as pictures. `naturalWidth` (row 1) needs the DOM; a paste and an IME commit were not read |
| `/posts` and associations scroll (first iOS feedback) | backlog, "The first iOS feedback" | **`PASS` on the BENCH iPhone**: three flicks on the associations list, momentum in 41 of 113 frames, the list moves 0 to 12 members down. The reading owed is on the REPORTING iPhone, which this is not |
| Section navigation on the phone (profile hub, breadcrumb) | CLAUDE.md queue item 0 | **`PASS`**: Mon profil > Cotisations et achats shows the crumb and "Retour : Mon profil", and the crumb goes back. A synthetic edge swipe did NOT go back on that page (not a verdict: whether the edge swipe applies there is not written down) |
| An attachment over 1 MiB on dev (WP-S1 #1708, #1710 on iOS) | backlog Cloudflare P1, offline section | **sent**: a 5 s gallery video in a one-member group read "Message envoyé" in ~2 s. Its size was NOT measured, and the server log read was refused to the agent, so this does not close the 1 MiB question |
| #1604, no PIN prompt after a later sign-in | backlog | **BLOCKED** by the P3 "switching accounts on one iPhone install makes the local store unreadable", which this session met again (below) |
| #1536 / #1548 reaction toast, send path, reply context | backlog | **BLOCKED**: no peer that the dev service account may discover |
| NOTIF-18 (NSE on a silent frame), the iPhone salon banner, a push carrying its ciphertext once, the iOS reaction stack, mention names, check B/C/K on iOS | backlog, notification sections | **BLOCKED on the estate**: dev cannot send a push (Firebase not initialised in `canari-dev-chat-delivery-service`), and a TestFlight pre-release only talks to dev |
| Check U (biometric cadence, all of iOS) | check U | **BLOCKED**: needs an enrolled face |
| The iOS launch logo (#1289): delete, RESTART, reinstall | backlog | **not taken**: a restart kills the WDA runner the session depends on. Owed in a session that can re-arm `wda-daemon.py` |
| The window bars (status bar, home indicator) with the glass chrome | backlog, iOS window layout | **screenshots for the user's look** in `r1011/` (`17-group.png`, `19-plus.png`). Seen: the dev banner sits over the status bar on the camera screen (`09-cam.png`), dev builds only |
| The reel editor end to end (text, drawing, stickers, "Suivant"), real-content take, viewer swipe timing | backlog, CanaReels | **WAITS for the next pre-release**: #1739 and #1742 (the 9:16 frame, the editor full-bleed and keyboard-proof) merged after `v1.2.3-alpha.5` |
| #1742 reel frame parity | PR | **WAITS** (merged, in no release yet) |
| #1738 IndexedDB eviction: kill with a queued 13 MB file, relaunch | PR #1738 (open) | **WAITS**: the PR is not merged |
| #1744 feed reel fetch, playback start | PR #1744 (open) | **WAITS**: not merged |
| An account deletion empties the App Group copies: delete a throwaway account on a debug (inspectable) build, then list `group.fr.emse.canari` - no `push_context.json` or `fcm_message_cache.ndjson` left, `mls.bin` / `graine_seeds.json` / `push_secret.txt` kept; `[DEL-LOCAL] push files: N removed from the extension's container` in the log, no `no App Group container` | [auth](frontend/modules/auth.md#an-account-deletion-wipes-that-accounts-local-database-and-vault-slot-wp-del-local-2026-10-18), added 2026-10-19 | **WAITS for a pre-release carrying it**: the `#[cfg(target_os = "ios")]` branch is not even compiled before the release's iOS build |
| PDF viewer performance | branch `perf/pdf-viewer` | **WAITS**: no pull request yet |
| Session holds, check P | CLAUDE.md | **not re-read by rule**: proven, "must not be re-verified" |

**Met again: the account-switch P3, and how the bench got there.** TestFlight "Mises à jour
automatiques" was ON, and it had replaced the bench's `1.2.2-alpha.1` with the `1.2.3` STABLE, a
build that talks to PRODUCTION. Installing `100200305` from "Builds précédents" turns automatic
updates off for the app (TestFlight says so), which keeps it off. The next sign-in as gamma then
answered `auth_local_state_unopenable` on the right PIN, and the documented remedy cleared it:
uninstall, reinstall, sign in. "PIN oublié ?" was not used, because it would reset the ACCOUNT's
PIN. A fresh install then asks for notifications, the microphone and the camera, and, the first time
a URL is opened, for iOS 27's default browser, which must be answered (Safari) before `ios.mjs url`
or a Safari launch is allowed.

## The Mi 9T readings of v1.2.4-alpha.2 (2026-10-12)

Build `1.2.4 (100200402)`, the `v1.2.4-alpha.2` release APK, on `dev.canari-emse.fr`, signed in as
the `fourth` account (shown as "Canari Test Delta"). It was already installed when the readings
started, and nothing was reinstalled. The WebView is inspectable, so every number below comes from
CDP (console, heap, DOM geometry) and screenshots, and every timestamp is the phone's. Evidence:
`<harness-dir>/a1-bench/r1012-alpha2/` (frames, `send13.jsonl`, `slow.jsonl`,
`dom*.log`). Frames that showed a tester's face were not kept.

| Reading | Verdict | What was seen |
| --- | --- | --- |
| A ~13 MB video, sent in a DM | **`PASS`** | The file was a 12.9 MB, 20 s, 1080x1920 test pattern picked from "Tous les fichiers". `[video-prep]` brought it down to 7.4 MB (720x1280) in 12.1 s, before the send. After the tap on send: the outbox row was durable at +1.4 s (`durable write took 218 ms`), the bubble read `Envoi 24 % - 1,8 Mo sur 7,4 Mo` at about +2.9 s (first byte in under 3 s), and `[OUTBOX] ... sent` came at +6.3 s, with the check mark. No bubble stuck on "Envoi". The JS heap stayed at 18-21 MB throughout. Logcat shows no OOM, no GC storm and no lmk kill. Two things worth noting: the transcode keeps the main thread busy (TaskDuration +7.6 s over 12 s), and the pending tile shows a generic file icon instead of a video thumbnail. The poster appears about 15 s after "sent" |
| Reel camera, 9:16 full-bleed | **`PASS` (geometry)** | Swiping right from `/posts` opens `/camera`. The preview is `436x775` CSS px at x=0 (full width), exactly 9:16, `object-fit: cover`, with a 12 px radius. The stream is 720x1280 from the FRONT lens by default. The room was dark at 02:00, so what the picture showed was not judged. The first time only, the swipe stopped half-way behind the microphone permission prompt |
| Reel editor: keyboard, tray, trash, caption against the bar | **`FAIL`, one defect** | The keyboard lifts the text field and the tray above the IME. Dragging an overlay brings up a central trash that turns red, and dropping onto it deletes the overlay (`PASS`). The caption wraps over two lines, and "Publier" sits above the keyboard (`PASS`). **Defect: an overlay is not kept inside the frame.** Dropped on the tool tray, it is drawn OVER the tray icons. Its visible part cannot be grabbed again: a grab from the screen edge fires Android's back gesture, which opens the "Abandonner vos modifications" dialog. It is then baked into the published reel, clipped at the frame edge ("Test reel al" in the thumbnail and in the feed) |
| Legacy reel in the viewer | **`PASS`** | A reel from before #1742 (588x1040, posted 15 h earlier) opens at `436x771` with `object-fit: contain`: no bars, rounded, on a blurred backdrop, with its controls inside the frame |
| Feed reel playback start | **`PASS`** | An IntersectionObserver records `play`/`playing` 51 ms after the video reaches 50 % visibility. It plays muted, by itself. It was already cached, so a COLD first fetch was not timed |
| The slow-link hint is a corner icon, not the "Connexion lente" banner | **`PASS`** | Provoked with no root by `settings put global ingress_rate_limit_bytes_per_second 18000` plus a Wi-Fi cycle. `[CONNECTIVITY] slow link` mounts `slow-link-indicator`: a 28x28 CSS px round badge at the top right (x=400, y=42), opacity 0.8, with the SignalLow glyph, and no strip. The label is in `aria-label`/`title` only. At 8 and 14 KB/s, two 20 s stalls turn it into the "Hors connexion" banner, which is the offline state and the right one for an unreachable server. On dev, the badge sits over the "Environnement de test" banner |
| Media cards in the dark theme | **`PASS` by eye** | The chat video bubble (dark placeholder, then the poster), the feed image card on its blurred dark backdrop, the link-preview card and the viewer all look right. The light theme was not read |

Also met: in the post composer, "Filmer" opens the SYSTEM camera (`org.lineageos.aperture`), not
the CanaReels camera. In the reel camera, a TAP on the shutter takes a photo. The capture here was
therefore a still, so the editor was read on an image and not on a video. Deleting a post from its
menu asks for no confirmation. The PDF viewer measurement was not taken in this pass.

## The Mi 9T readings of v1.2.4-alpha.3 (2026-10-12)

Build `1.2.4 (100200403)`, the `v1.2.4-alpha.3` release APK (`app-universal-release.apk` from the
GitHub release), installed with `adb install -r` over alpha.2. Play Protect's upload prompt was
declined. The enrolment survived the upgrade, so there was no new sign-in: same `fourth` account
("Canari Test Delta") on `dev.canari-emse.fr`. Every number comes from CDP on the inspectable
WebView, and every timestamp is the phone's. Evidence:
`<harness-dir>/a1-bench/r1012-alpha3/` (frames `a3_*.png`, `a3_pdfm.json`,
`a3-cold-*.json`, `tap-summary.ndjson`).

| Reading | Verdict | What was seen |
| --- | --- | --- |
| Reel editor: a text overlay dropped on the tool tray (#1755) | **`PASS`** | A photo was taken in `/camera` and a text "Canari bord TEST" was dragged from the middle to the bottom-right, onto the tray (`input swipe`, real touches). The box settled at x 424-1078 of a 1079 px screen, its centre above the tool row and clear of it, and no glyph was cut. It was grabbed again from its centre and moved to the middle with no back gesture. Dropped on the tray a second time, it landed in the same place. The export (718x1278) and the published feed card show the whole caption with about 20 px of margin |
| Restyle with the keyboard up | **`PASS`, one thing to know** | With the field open and the keyboard up, changing the font (serif) and then the background style left the centre exactly where it was (751, 1883). But the restyled box got WIDER than the space left (its right edge went to 1106, then 1150, past the 1079 px screen), so during the edit "TEST" was cut at the screen edge. It is pulled back inside only at "OK" (right edge 1077, centre moved 73 px to the left), and that is the state that publishes. A tap on a style also hid the ADB keyboard (the viewport went from 2116 back to 2339 px) |
| A tap on a stroke | **`PASS`** | A pencil stroke, then two taps on it: the stroke is selected (dashed box) and stays where it was, and the text overlay stays at 424/1818/1078/1949 |
| PDF reader in the app: `pic86.pdf` (81-page 14 MB scan, the owner's file, read with permission), sent in the BenchR1 DM from "Tous les fichiers" | **`PASS`, one defect** | Sent with its check mark. The first-page thumbnail on the card took ~25 s to replace the spinner. Times measured by CDP from a scripted click on "Ouvrir le document" (blob already decrypted by an earlier open): **first page painted at 663 ms, sharp at 852 ms**. **Seven real flings** (`input swipe`, 60 ms each): the landing pages (80-81) were sharp **1.08 s** after the last one, with 7 long tasks over the fling, 758 ms in total, the longest 221 ms. **Page 40**, reached by setting `scrollTop` (the reader has no page-jump control): drawn at **28 ms**, sharp at **609 ms**. **Text selection**: a long press on the OCR layer selects the word ("les", highlighted on the glyph) with the system menu (Copier / Partager / Tout sélectionner). Dragging a handle extends the selection across lines. The copied text joins two lines with no space ("les**autres** Grandes Ecoles"). **Defect, zoom loses the reading position:** zooming in from page 80 (x3, scripted) landed on pages 26-27. A REAL tap on "Agrandir" from page 40 (printed page 39) landed on page 27 (printed page 26). `scrollTop` stays the same while every page gets taller, so the reader ends up at page / zoom. The pinch anchors on its page ([posts](frontend/modules/posts.md#the-pinch-and-why-it-needs-a-focal-point)), but the buttons do not. Sharp after the last of three clicks: 1.49 s, longest task 404 ms |
| Notification tap to conversation, cold, behind the PIN (n=5) | **`PASS`** | Same method and instrument as [notification-to-conversation-latency](frontend/notification-to-conversation-latency.md) (the exact PendingIntent `am start`, then the PIN typed by the instrument). Medians [range], in ms after the tap: PIN gate 1665 [1627-1749], PIN submitted 1953 [1920-2130], `MLS ready` 2749 [2667-2905], route `/chat` 2965 [2870-3125], **pane + composer usable 3296 [3191-3449]**, first history row 3880 [3796-4107]. PBKDF2 106-136 ms, `mls-init` 28-48 ms. That is **0.53 s better than F2 (3825)** and **1.77 s better than the `main` baseline (5063)**. The gate matches F3 (1741). The feed's 20-card mount never ran under the landing. **Back from the conversation**: Back opens the conversation list. The feed tab then shows its posts (no stuck skeletons) |
| Quick regression: a text, then a ~14 MB video in BenchR1 | **`PASS`** | The text was `msg-status-sent` within 3 s. The video was a 14.5 MB, 9 s cut of the 12 Mbit/s test pattern from "Tous les fichiers". After "Préparation de la vidéo", the bubble showed a placeholder and then its poster, with the check mark, within 30 s of the tap. The staged tile still shows a generic file icon. **Slow-link badge: not provoked.** On fast Wi-Fi the `slow-link-indicator` never mounted and no banner appeared over the 180 s of polling. The corner-icon form was read on alpha.2 with the rate limit (above), and nothing between the two builds touches it |

Also met: swiping right on `/posts` (three `input swipe` attempts, on the media and on the post
header) did not open `/camera` in this pass. The camera was reached through a link click. In the
post composer, "Appareil photo" opens the system camera.

## The Mi 9T readings of v1.2.6-alpha.1 (2026-10-13)

Build `1.2.6 (100200601)`, the `v1.2.6-alpha.1` release APK (`app-universal-release.apk`, sha256
`43b5b2a8...`), on `dev.canari-emse.fr` (`dev.7b97c2a`). The phone carried a debug-keystore build,
so this was an **uninstall and a fresh install**: a NEW device, signed in again as the `fourth`
account ("Canari Test Delta"), with "Rester connecte" unticked, so every cold open asks for the PIN.
The peer is `canari-test-gamma` in the `chrome-w2` dev tab. Every number comes from CDP on the
inspectable WebView. Evidence: `<harness-dir>/a1-bench/r1013-a126/` (run JSONs,
`cycle-a126.ndjson`, the console captures `cons-*.ndjson`, frames). The salon items ran in a bench
community, `Bench126`, created by gamma for this pass (gamma administrator, delta member).

| Reading | Verdict | What was seen |
| --- | --- | --- |
| Killed notification tap to composer to the notified message, behind the PIN (n=6) | **`PASS`** | Same instrument and method as [the 1.2.5 reading](frontend/notification-to-conversation-latency.md#the-whole-cycle-tap-to-delivered-reply-2026-10-12). Medians [range], ms after the tap, `1.2.5-alpha.1` then this build: route `/chat` **3121 -> 1987** [1934-2092]; composer usable **3632 -> 3168** [3060-3536]; the notified message's row **4606 -> 3673** [3510-3995]; composer -> notified row **945 -> 455** [427-518]. `MLS ready` 2899 -> 2587. Warm (backgrounded 6 s, n=6): composer 1193 -> 935, notified row 1882 -> 1789. Send click -> outbox `sent`: killed 655 -> 638, warm 610 -> 514 |
| F1: nothing drawn before the PIN is accepted | **`PASS`** | The route is `/chat` at ~2.0 s while the PIN gate is up. With the gate on screen, the DOM holds **0** message rows and no message text (read over CDP), and the frame shows the opaque keypad only (`f1-gate-6s.png`). In all six runs `[LANDING_PREVIEW] ... drawn from the local store` comes 85-190 ms after the `pin-check` request has answered |
| PIN entry latency | **`PASS`** | PIN submitted -> `MLS ready`: median **436 ms** [397-1211] against **811 ms** [761-1099] on `1.2.5-alpha.1`. The salt is asked while the keypad is up (`[PIN] Salt asked while the keypad was up`, `pin-salt-fetch` 0-30 ms at submit). The one slow run is `mls-save-state` taking 535 ms, not the PIN path. The gate itself is unchanged: drawn at 1732 ms (1724 before) |
| A salon message is shown at once and settles | **`PASS`** | Three sends with real taps (`adb input`): the bubble is drawn **27-45 ms** after the click with "Envoi...", re-keyed to the server id at **232-759 ms** with "Message envoye", the status line gone at ~2.4-2.9 s. One row on each side (no duplicate), and the peer has it |
| Double tap likes WITHOUT opening the info panel; single tap opens it | **`PASS`** | Four double taps (two as CDP touch pairs 130 ms apart, one as two `adb input tap` in one shell, one in the logged session): one heart each, seen on gamma's tab, and **0 frames** with the info panel in the 1.5 s after. Single taps: the panel ("Envoye a ... Lu par ...") opens, 57-58 frames |
| Polls: manual close, shortcut jump, pinned bar alignment | **`PASS`** | The author (delta, phone) closed poll A: "Cloturer le sondage", system confirm, OK; both clients then read "Termine", `closable: false`, and the "1 sondage actif" pill disappears on both. Gamma (administrator) is offered the close on delta's poll B and closing it from the web ends it on the phone. With 25 messages below, the poll entry of the pill brings the poll into view (its title at y=414 of 945 CSS px), and the pinned entry brings the pinned message into view. The three pills (title, polls, pinned) share one centre line (x=461 of 923 in the frame) |
| The typing bubble stands clear of the composer | **`PASS`** | Gamma typing: the bubble's bottom is **16 CSS px** above the composer's top (wrapper 819.7-869.65, composer top 869.46, the wrapper's 16 px padding below the bubble) (`typing.png`) |
| "Seen by" heads do not flicker in a community | **`PASS`** | Heads sampled every 16 ms. Live exchange: every move is one step to the newest read row, never back. Three reloads of gamma's tab: delta's head is under `seen-c` from the first sample (~200 ms) and never moves in 12 s. Two cold starts of the phone into the salon: gamma's head is under `seenphone3` from its first sample and never moves in 15 s. `canari-dev-social-service-1` logged **0** `[CHANNEL_READ] mark past the newest message bounded` in the 40 min of the pass |
| Nothing fatal in the logs | **`PASS`** | 2326 console lines over the 12 timed runs plus two full captures (a cold start, a salon session; `Runtime.enable` replays from page load): **no** `error`/`warning` entry, **no** exception, **no** `[SELECT] selection dropped`. The only `[RESTORE]` line is the normal `N conversation row(s) seeded - history follows`. Logcat: no `FATAL`, no ANR; every process death is the instrument's own kill |

**Not measured, and why.** T1 (the notification shown) and a REAL notification tap: dev has no push
(`DEV_FIREBASE_SERVICE_ACCOUNT_JSON` absent), so the tap is the notification's exact `PendingIntent`
fired with `am start`, as in the 1.2.5 reading. The PIN is typed by the instrument (~130 ms); a
person adds 1.5-3 s. The landing preview under the vault path ("Rester connecte" ticked) was not
read, since this device is on the PIN path. The first ~100 ms after a salon opens are not covered
by the heads sampler (it is installed before the tap on the phone, after the open on the web).

**Met on the way, not asked about:**

- **The creator of a community is not offered "Epingler" until a reload** (FIXED 2026-10-13: the
  creation answer omitted `viewerCanModerate`, which also hid the close of another member's poll,
  [social-service](services/social-service.md)). Gamma created `Bench126`
  in the web tab; the message menu in its salon showed Transferer / Modifier / Supprimer and no
  Epingler, although the database gives gamma the Administrateur role (`channel.moderate`). After a
  reload the same menu has Epingler. One observation; whether "Cloturer le sondage" was also missing
  before the reload was not read.
- **The poll close confirmation is the system dialog with English buttons** ("CANCEL" / "OK") over a
  French sentence (`poll-close-1.png`). FIXED 2026-10-13: `ChannelPoll` asks through the app's
  `showConfirm`; no `window.confirm` is left in the frontend.
- **The sticky "AUJOURD'HUI" pill sits partly under the pinned pill** after the pinned jump
  (`pinned-jump.png`). **RE-READ 2026-10-13: the pill in that frame is NOT the sticky one** - its
  letters are spaced (`tracking-widest`) and its padding is wider, which is the IN-THREAD date
  separator (`ChatMessageGroups`), a content row scrolling under the floating glass chrome as every
  row does; the sticky pill is `letter-spacing: normal`. The sticky pill's own placement was
  measured in desktop Chrome at 390 px with the glass chrome forced on: `--chat-header-height`
  follows the pinned list closing (159 -> 113 -> 111 px within 100 ms) and the pill lands 13.6 px
  below the pinned bar. Nothing to fix on the sticky pill. Still unexplained: the jumped-to message
  in that frame was not centred, and the frame does not say which message was pinned - the next
  reading should name it.
- **The phone's long-press menu has no "Epingler" for a plain member**, which matches
  `mayPinMessage`.

## The bench readings of 2026-10-13 - the owed rows a bench phone can settle

Both bench phones, dev estate, bench accounts only. **Mi 9T**: the same `v1.2.6-alpha.1` release APK
as the section above, account `fourth` ("Canari Test Delta"), every number from CDP on the
inspectable WebView. **iPhone 12**: TestFlight `1.2.3 (100200305)` = `v1.2.3-alpha.5`, account
`canari-test-gamma`, driven over WDA (not inspectable). Evidence:
`<harness-dir>/a1-bench/r1013-owed/` and `.../ios-bench/r1013/`. Frames in which a
third-party app's heads-up notification showed a real person's message were deleted and re-taken
under Do Not Disturb.

**What the iPhone can run.** TestFlight offers this tester the `1.2.6 (100200699)` STABLE (a
production build: not bench) and, under "Builds precedents", nothing newer than the `1.2.3` group:
**no `1.2.4`, `1.2.5` or `1.2.6` pre-release build reaches the iPhone**, although every one of
those release runs built and uploaded its IPA (`v1.2.6-alpha.1`: "App Store / Build iOS IPA",
success). So every iPhone row below is on `1.2.3-alpha.5`, and every iPhone row whose fix is newer
stays owed until a pre-release build is distributed to the tester group.

| Reading | Phone | Verdict | What was seen |
| --- | --- | --- | --- |
| Android at 200 % text (lot 5) | Mi 9T | **`FAIL`, two P3 in the agenda; the rest `PASS`** | `font_scale 2.0` (root font 32 px). 15 routes walked through the client router plus a DM with the keyboard up: `scrollWidth - clientWidth = 0` everywhere, no text outside the viewport, the wordmark and the conversation name truncate, the composer fits over the keyboard, the PIN sheet scrolls to every option (at rest the `0` row is cut by the footer, reachable by a scroll). **`/calendar`**: (1) "S'abonner au calendrier" is wider than its card and spills 33 px out of the card's LEFT edge (button x=7, card x=41; `flex-wrap justify-end`, `calendar/+page.svelte:670`); (2) today's day number `13` is drawn at 40 px in a fixed 36 px circle and overruns it (`h-9 w-9 ... text-lg`, `CalendarScheduleList.svelte:226`) - the avatar-initials class of defect, not exempted by `.text-zoom-exempt`. Icons do not grow with the text (the WebView scales fonts, not lengths): not a defect by the 2026-09-30 decision. The dev banner takes two lines. Frames `t200-*.png`, audit `t200-audit.json` |
| Three-button navigation (lot 5) | Mi 9T | **layout `PASS`; ONE P2 `FAIL`** | Switched with `cmd overlay enable-exclusive --category com.android.internal.systemui.navbar.threebutton` (this phone runs LineageOS, where it works; restored to gestural afterwards). Insets read 34 px top, **49 px bottom**; the tab bar sits above the three buttons on all 15 routes, and the composer, the keyboard and the message action sheet clear them. **`FAIL`: with the message action sheet open (long press on a bubble), ONE system Back closes the sheet AND the conversation**, 3 of 3: `history.state` reads `{canariOverlay:1}` with the conversation open and stays at 1 with the sheet open - `MessageMobileActions.svelte` registers no history overlay, so Back pops the conversation's entry. Not specific to the three buttons: `KEYCODE_BACK` is the gesture's Back too. Frames `b3-*.png` |
| Check W, the composer during a keyboard rise | Mi 9T | **`PASS`** | [W above](#w-the-composer-stands-still-while-the-keyboard-rises---owed-on-both-phones): 869.5 -> 524 in one frame, 5 of 5; a 90 px keyboard escapes the double-report guard (P3) |
| Check V, the camera swipe after publishing | Mi 9T | **`PASS`** | [V above](#v-the-camera-swipe-on-a-fresh-feed-after-publishing---owed-on-android), 4 of 4 |
| "Rester connecte" path: cold open with no PIN, and the landing preview | Mi 9T | **`PASS`** | Unlocked once with the box ticked, then killed. A plain cold launch: no PIN gate in 40 samples over 11 s, `[PIN] Device key restored from PinVault - auto-login`, `Initialising MLS (vault device key path)`, `MLS ready` 0.53 s after the vault line. The notification's exact `PendingIntent` (`fr.emse.canari://chat/<id>`, `0x34000000`) on a killed app, n=4: no gate, `[LANDING_PREVIEW] ... drawn from the local store (60 message(s))` twice before and twice after the session is up, composer usable at 2.04-2.32 s of `performance.now()`, **0** error or warning lines. **The phone is LEFT on the vault path** (the box cannot be unticked without a sign-out): the next PIN-path reading must sign out and back in first |
| #1603 half 1: no `pauseSocket: native disconnect failed` on a background | Mi 9T | **`PASS`** | Three HOME-and-return cycles: `[WS] Paused - disconnect sent, socket released until the next foreground.` then `[WS] app back in the foreground with no socket - reconnecting`, each time; nothing in logcat for `pauseSocket` or `disconnect failed` |
| #1603 half 2: a scheduled post leaves the strip at its time | Mi 9T | **`PASS`** | The picker steps by 5 minutes, so the post was set for 11:20 at 11:15. "Publications programmees (1)" listed it until 11:19:31 at least; at 11:20 the strip was gone and the post was in "Tout", "A l'instant". The watcher's CDP call timed out once at the minute, so the second the strip left was not captured. Post deleted afterwards |
| Android fluidity (#1361-#1363), tap -> conversation pane | Mi 9T | **re-measured** | `pointerdown` on the DM tile -> the frame after `.chat-composer-footer` exists, warm: first open 412 ms, then 287-315 ms (median of 6: 310 ms), each with one long task of 257-349 ms. Against 662 ms on the first open before the three changes, on a debug build: the comparison is release against debug and is not a like-for-like attribution |
| #1605 "Ouvrir dans l'application", Android half | Mi 9T | **`PASS`** | `https://canari.emse.fr/login` in Chrome (not signed in) shows the link; the tap starts `act=VIEW cat=BROWSABLE dat=https://canari.emse.fr/... pkg=fr.emse.canari` from Chrome and Canari comes to the front |
| #1548 the reply context is per conversation | iPhone | **`PASS`** | "Repondre" armed on a DM message ("Repondre a Canari Test Delta"); the `Bench126` salon opened with no reply bar; back in the DM the bar and its quote were still there; cancelled afterwards |
| The send path on the iPhone (#1536 row) | iPhone | **`PASS`** | `ios1013send` in the DM: "Message envoye", the double check, and the Mi 9T's list shows it. **The reaction-failure toast was not read**: nothing here makes a reaction fail |
| #1604, no PIN prompt after a later sign-in | iPhone | **answered in part: NOT the "Rester connecte" vault** | The install sat on the login page; a sign-in as gamma landed on the feed and `/chat` with NO PIN, history decrypting and a send working. A cold relaunch ~9 minutes later DID ask for the PIN - which a vault would not have - and its sheet has no "Rester connecte" row (`showStaySignedIn = !biometricConfigured`). So the unlock was skipped on a key the live process still held. **Then the right PIN on that cold launch answered "Vos messages enregistres sur cet appareil n'ont pas pu etre ouverts"** - the [account-switch P3](backlog.md#p3---switching-accounts-on-one-iphone-install-makes-the-local-store-unreadable) met again, here with no switch inside this session (which account the install held before it is unknown). Remedy taken: uninstall, reinstall `100200305` from TestFlight, sign in (the PIN asked this time), unlock |
| Dynamic Type at the largest standard size (lot 5) | iPhone | **no effect, warm or cold** | Reglages > Accessibilite > Affichage et taille du texte > Police plus grande, slider 50 % -> 100 %: a DM drew at exactly the size it had before, and so did the PIN sheet after a cold relaunch. The WebView ignores the setting, so Dynamic Type users get the default size. Whether that is accepted or wants `-apple-system-body` is a decision, not a reading. Restored to 50 % |

**What a bench phone cannot settle, and why.** Every push row (check H step 4, NOTIF-10, D2/D3 with
a shade reply typed by hand, the sender's face on a notification, NOTIF-6b, check K and C): dev sends
no push (`DEV_FIREBASE_SERVICE_ACCOUNT_JSON` absent) and the iPhone's development slot has no APNs
key. Check X needs a real finger. The iPhone rear-lens letterbox (#1370) needs the phone held up.
Check U and the iOS launch logo need a person (a face, a restart that kills WDA). The emoji
`naturalWidth`, the liquid glass re-read and every fix newer than `1.2.3-alpha.5` need an iPhone
build newer than the one TestFlight serves this tester.

## The Mi 9T readings of v1.2.7-alpha.1 (2026-10-13/14)

Build `1.2.7 (100200701)`, the `v1.2.7-alpha.1` release APK (`app-universal-release.apk` from the
GitHub release, sha256 `156ae21e...`), on `dev.canari-emse.fr`. The phone had no Canari, so this was
a **fresh install and a new device**, signed in through the service-account link as `fourth`
("Canari Test Delta"), "Rester connecte" unticked. The peer is `canari-test-gamma` in the
`chrome-w2` dev tab. Numbers come from CDP on the inspectable WebView and from logcat (the Rust
lines reach logcat, the WebView console does not). Dev still sends no push
(`DEV_FIREBASE_SERVICE_ACCOUNT_JSON` absent), so the notification is its exact intent fired with
`am start`. Evidence: `<harness-dir>/a1-bench/r1013-a127/` (frames, `cons-*.ndjson`,
`logcat-*.txt`, `inapp-log*.txt`, `notif-runs2.ndjson`).

**Another session drove this phone during the pass** (00:02-00:05: three force-stops from a shell,
`fr.emse.canari://post/0000...` and `://open/...` deep links, and wrong PINs typed on the gate). The
readings below were taken before it or after three quiet minutes.

| Reading | Verdict | What was seen |
| --- | --- | --- |
| Native checkpoint (#1826) | **`PASS`** | 60 `[MLS] checkpoint: manager lock held N ms (export), seal + write M ms off it` lines: **N = 0 ms 51 times, 1 ms 8 times, 2 ms once**; M median 2 ms, p95 5, max 9; state up to 304 KB. **0** `reload REFUSED`, `reload DROPS KEY MATERIAL`, `mls.bin write FAILED` or `ordering lock was poisoned`; no FATAL, no ANR |
| No stall on a salon open | **`PASS`** | Five real taps on a 56-row salon: one long task per open, **293-412 ms (median 335)**, the longest frame gap 425 ms, nothing over half a second. Same shape as the DM open of the 1.2.6 bench (257-349 ms) |
| In-app log (#1819): the save | **`PASS`** | Settings > A propos > "Enregistrer le journal" opens the system picker on Telechargements with `canari-log-1.2.7-alpha.1-<date>-<time>.txt`; "Enregistrer" writes it (68 KB, 748 lines) and the app says "Fichier enregistre." |
| In-app log: the redaction | **`FAIL`** | No name, e-mail, JWT, Bearer, full UUID, password, PIN or OIDC subject in either export. **But message text survives when it is one word or identifier-shaped**: `[SEND] handleSendChat: ... text="ok"`, `text="coucou"`, `text="refuse1-a127"`, while `text="Rendez-vous demain chez Paul a 18h"` became `"[34 chars]"`. `text` is in `PROSE_LAST_WORDS`, yet the quoted-value shape allowlist still keeps a value that looks like an identifier (`appLogRedact.ts`) |
| "Marquer tout comme lu" on a community icon (#1820) | **`PASS`** | A long press opens the menu with nothing selected (`getSelection()` empty). The tap clears the salon's `6` and the rail dot; the badge stays clear after a kill and relaunch. Gamma's tab, reloaded: delta's "Message lu par" head stays on `in-bg-mv6hmrir` (11:53), not on the six newer rows |
| Drag-reorder of the rail | **`PASS`** | With a second community (`Bench127`, created for this), a long press + drag moves it above `Bench126`; no menu is left open |
| Salon send before the salon is loaded (#1821) | **`PASS`** | Cold start from the salon's deep link, link throttled to 15 KB/s, sent at composer-usable: **"En attente..." for 1.9 s**, `[SEND] channel send ... HELD`, then `released: its salon is loaded`, "Envoi...", "Message envoye" at 4.6 s; one copy on gamma's side, no banner. Unthrottled, the same send never waits (the salon is loaded in time) |
| The refusal banner | **`PASS` (geometry)** | Provoked by cutting the Wi-Fi right after the unlock: "Rien n'a ete envoye : vos communautes n'ont pas pu etre chargees..." sits in the composer footer, opaque (alpha 1), the last row ending 24 CSS px above the footer, no overlap |
| A salon after an offline start, once back online | **`FAIL`, P1** | Back online, `[WORKSPACE-LOAD] online event` tried once and gave up as **non-retryable**: the Tauri HTTP error `error sending request for url (...)` is neither a `TypeError` nor a `DeliveryUnreachableError`, so `isRetryableLoadError` calls a transport failure fatal (`[CHANNEL] ... unclassified failure`). For 2.5 min, online with the socket up, the rail was EMPTY ("Selectionner ou creer une communaute") and every salon send and Retry was refused `listing-failed`. Only the next foreground's online event reloaded it |
| Reactors list on a long press | **`PASS`** | Long press on a heart chip (`aria-label` "(1 personne)"): the list ("Canari Test Delta") opens 5 CSS px under the chip, left edges aligned (chip 60-90 x 540-562, list 61-221 x 567-622); no message sheet |
| Typing bubble, three-button navigation | **`PASS`** | Bottom inset 49 px. Gamma typing: the bubble's wrapper ends at 844.8 CSS px, the composer footer starts at 844.5, the bubble itself 16 px above it |
| A salon row tap does not tap a message | **`PASS`** | Control: a tap on a bubble logs `[MESSAGE] bubble tap ... single, info panel`. Then six real taps on the salon row at a point that has a bubble under it once the salon is drawn: six opens, **0** `[MESSAGE] bubble tap` |
| Notification intent, killed, behind the PIN (n=5) | **`PASS`** | `performance.now()` of the new page, medians: PIN gate 1204 ms, route `/chat` 1736, composer usable with 56 rows 3421 (PIN submitted at 2511, the instrument waits 400 ms for a still keypad). Not comparable 1:1 with the 1.2.6 numbers, which count from the tap |
| Double tap / single tap | **`PASS`** | Double tap on gamma's bubble: `bubble tap ... double, heart`, `notify-reaction` 200, no panel in 1.5 s. Single tap: `single, info panel` |
| Polls | **`PASS`** | Created from the phone; gamma votes; "Cloturer le sondage" now asks through the app's dialog in French ("Annuler" / "Cloturer le sondage"); both clients read "Termine", the "1 sondage actif" pill gone on both |

**Met on the way:**

- **A configuration relaunch leaves the old WebView alive.** Switching the navigation mode (an
  overlay change, `Config changes=80000000`, which `configChanges` cannot absorb) relaunched the
  activity in the same process. CDP then listed TWO pages, the old one detached and unresponsive.
  It still held its `canari.salon-unsent.owner.*` Web Lock, so the three refused salon texts were
  never handed back to the composer: `[SALON-UNSENT] 3 entr(y/ies) kept: a live sibling tab owns
  them`. A System WebView update relaunches the same way.
- **Offline, the banner and the send disagree.** "Hors connexion ... les nouveaux messages
  partiront des le retour du reseau" is on screen while a salon send is refused at once
  (`listing-failed`, "Echec / Reessayer"). Offline, the salon's history is not drawn either
  (`[LANDING_PREVIEW] nothing drawn for channel_ (channel)`).
- **"Utilisateur inconnu"** names the DM peer for 60-125 ms after the landing is usable.
- **"Se deconnecter" on the PIN gate signs out with no confirmation**, one row under
  "Deverrouiller": the instrument's tap that raced the keypad animation signed the device out
  (re-signed in, same local state).

## Owed: the in-app camera in the composers (D-camera, 2026-10-11)

Built without hardware; the chain compiles and the vitest rows pass, which proves nothing about a
camera. **Owed one reading each on the Mi 9T and the iPhone 12:**

- **Chat, "+" then "Ouvrir la camera"**: the overlay covers the conversation, a tap takes a photo, a
  HOLD does NOT film, no microphone prompt appears (refuse the microphone: the photo still works), "Ajouter" STAGES the photo in the composer and the member then presses send (an ordinary image bubble), and the conversation (draft, scroll)
  is exactly where it was. Back (Android) and the edge swipe (iOS) end the review, then close the camera.
- **New post, "Ouvrir la camera"**: a tap gives a photo, a hold a video; "Ajouter" attaches it to the
  composer, the published post is a post (post retention), not a reel. No sound button in the review.
- **Android**: no system camera app is launched at any point (the `queries` and the capture
  `FileProvider` root are gone); the library picker still opens. **iPhone**: the camera permission
  prompt is the in-app one (`NSCameraUsageDescription` stays, `getUserMedia` needs it).
- The overlay over the keyboard and over a conversation with a pending draft; a camera refused
  (permission denied) shows the refusal screen with no native fallback.

## LIVE-B1. The broadcaster on both bench phones - owed on BOTH

The broadcaster of WP-L5 ([live](frontend/modules/live.md#the-broadcaster-as-built)), in every build
since the production flip of 2026-10-30 (`LIVE_ENABLED` in `features.ts`; both estates' servers open, `lives_mode` the runtime switch).
Every test of it runs on fakes: none of the readings below has been taken. Written 2026-10-19.

**Preconditions - each a reading:** both phones on a PRE-RELEASE build carrying the broadcaster
(Settings > A propos shows `X.Y.Z-alpha.N`, the store-serves-the-highest-build TRAP of CALL-L1
applies); two dev accounts sharing a space (a member's live is watched by readers sharing one); the
app's own viewer on the other phone - [check Y](#y-watching-a-live---owed-on-both-phones-mi-9t-iphone-12)
reads the same session from that side. Save the in-app log after each run
(Settings > A propos > "Enregistrer le journal"); the `[LIVE-PIPE] summary` and `[LIVE-BROADCAST]`
lines are what decide each row - no key, no segment byte is ever in them.

| Row | Mi 9T (app WebView) | iPhone 12 (app WKWebView) |
| --- | --- | --- |
| **1. Ten minutes on air**, the other phone watching: the composer's "En direct" chip, the rules screen with 60 min and 60 s from the server, Start, the red badge and its clock. Log: `[LIVE-BROADCAST] on air (recorder 1)`, a summary every 30 s with `not on keyframe 0`, `dropped 0`, and `two-fragment chunks` near 14 % of segments on Android (0 on iOS) | owed | owed |
| **2. Background and return**: home for ~20 s, back. The screen shows "Camera en pause" while away, then the badge again on the SAME live; the viewer sees a gap then catches up. Log: `recording paused: the app is in the background`, `re-acquiring`, `on air (recorder 2)`, and `generation 2 begins at +<ms>` | owed (the WebView ENDED the track in WP-L1: the release-on-hidden must make that moot) | owed (WP-L1 saw a MUTE in Safari; the app's WKWebView is unread) |
| **3. Background past the window**: home for 90 s, back. The end screen says the live stopped while the camera was paused; no camera opens. Log: `ended while the camera was away` | owed | owed |
| **4. Network cut and restored** (airplane mode ~20 s, on air): the quiet "Reconnexion..." badge with a growing backlog, which drains by itself when the network returns; nothing ends. Log: `reconnecting`, then summaries resuming with no `dropped` | owed | owed |
| **5. End**: End, "Continuer" keeps the live, End again and confirm. The viewer's live ends; the end screen says you ended it. Log: `ended (broadcaster)` | owed | owed |
| **6. Battery, UNPLUGGED, 30 min on air**: the level before and after, the phone's heat by hand. Also: under 60 % the rules screen shows the battery warning (Android only: WebKit has no Battery API) | owed (WP-L1: ~40 %/h PLUGGED) | owed (no warning expected) |
| **7. The screen stays on** for the whole of row 1 without a touch (the Screen Wake Lock); if the log says `no Screen Wake Lock API here`, that engine dims and it is a finding | owed | owed |
| **8. Does a NEW recorder's media time start at 0?** After row 2's return, read the first segment of `recorder 2` on the viewer side (or the rig's `readTimes`): its `tfdt` must be the `+<ms>` of `generation 2 begins`, NOT that plus the time the first recorder ran. `rebaseFragment` ASSUMES a fresh recorder restarts at zero - WP-L1 never measured it; an engine that keeps counting would put the second recorder's picture in the future for every viewer | owed | owed |
| **9. Network cut longer than the window** (airplane mode ~90 s, on air): the end screen says the connection was lost too long, the camera light goes off. Log: `segments waiting, over the <n> the reconnect window holds`, `ended (connection-lost)` | owed | owed |
| **10. End while offline**: airplane mode, End, confirm. The camera light goes off AT ONCE; the screen says the last seconds are being sent and offers "Quitter sans attendre", which closes it. Log: `camera given back; <n> segments to send` | owed | owed |

## CALL-L1. A 1:1 dev call between the two bench phones - owed on BOTH

Lot 1 of [calls](frontend/modules/calls.md#lot-1-2026-10-17---11-audio-peer-to-peer-dev-builds-only):
in-app 1:1 AUDIO, peer to peer, Cloudflare TURN as the last resort, on dev builds only
(`CALLS_ENABLED = CALLS_COMPILED || deployEnvironment() === 'development'`). Nothing in it was ever
run on a phone ([2026-10-18 bench](device-readings-calls-live-2026-10-18.md): `BLOCKED`, dev was on
`1.2.9-alpha.7`). Written 2026-10-19, when dev served `1.3.0-alpha.4` with the dev TURN pair.

**Preconditions - each one is a reading, never assumed:**

1. **Both phones run a PRE-RELEASE build**: Settings > A propos shows `X.Y.Z-alpha.N` and the app
   talks to `dev.canari-emse.fr`. A stable build has `CALLS_ENABLED = false` and no call button.
   **TRAP: a store serves the HIGHEST build number.** The stable `1.3.0` is `100300099` and outranks
   `1.3.0-alpha.4` (`100300004`), so once `1.3.0` is offered, Play updates the Mi 9T to a build that
   cannot call; on TestFlight, pick the alpha build by hand. When Play offers no alpha above the
   latest stable, the reading needs the next pre-release (`v1.3.1-alpha.1` = `100300101`).
2. **Two dev accounts, one per phone, sharing a DIRECT conversation**: calls are offered in direct
   conversations only. No block between them (a block refuses the call with `call_unavailable`).
3. **The call permission is not refused**: the conversation's panel, "Appels", reads "Autorises", or
   no choice was made and the level is not `none`.
4. **Both apps OPEN, in the foreground, screen on.** The ring is the MLS `call_invite` over the chat
   socket. A killed or backgrounded app is NOT rung (`CALLS_COMPILED = false`, no native ring; and dev
   has no Firebase sender, so chat-delivery logs `[ring] Firebase Admin is not initialised` at every
   ring - expected on dev, not the finding).
5. **The microphone prompt** appears on the first call on each phone: accept it.

**The log.** A store build is not inspectable: Settings > A propos > "Enregistrer le journal" saves
the in-app log after each call. **Never paste the `[Call] encryption key derived from MLS (fp=...)`
line of a build older than 2026-10-21 into this public repository** - it printed key bytes. From
then on the line reads `media keys derived from MLS (role= send_fp= recv_fp=, sha256)`, a hash of
each direction's key, safe to quote ([calls](frontend/modules/calls.md)).

**Steps:**

| # | Action | Expected on screen | Expected in the log |
| --- | --- | --- | --- |
| 0 | **FIRST, before any other row, on the build carrying #2148**: one p2p call on dev, connected, then left IDLE (nobody speaks, no network change, both apps in the foreground, screens on) for **more than 60 s** | the call goes on: no "Reconnexion...", no end | server (dev `call-service`): `[call] p2p paired ...` and **NO `held dead`, `keepalive-lost` or `not taken within` line** for either peer over the whole idle minute. It proves the keepalive's Pong crosses the PUBLIC path (Cloudflare tunnel + host nginx) - which no local test covers; a `held dead` line here means the path eats Pongs, and every other row would read the keepalive, not the network |
| 1 | Mi 9T opens the DM, taps "Appel audio" | the call screen; the iPhone rings IN-APP within seconds | caller: `[Call] fetching ICE servers for group=...`, `[Call] server ring sent - answer window open`, `[Call] signalling connected, joining p2p room...`, `[Call] p2p room ready (...)`; callee: `[Call] signal from <id> in <group> call=<id>` |
| 2 | iPhone answers | both show the call in progress; each hears the other, both ways, for at least 30 s | caller `[Call] peer ready - this side is initiator`, callee `... is polite`; `[Call] offer (...) -> peer` / `[Call] answer (...) -> peer`; `[Call] connectionState=connected`; `[Call] selected path pair=<local>/<proto>-><remote>/<proto> relayed=yes\|no`; `[Call] E2E encrypting audio` and `[Call] E2E decrypting audio`; `[Call] remote track unmuted kind=audio` |
| 3 | iPhone hangs up | both screens leave the call; the conversation shows the call line | no `[Call] terminal failure` |
| 4 | Steps 1-3 the other way: the iPhone calls the Mi 9T | the same | the same, roles swapped |
| 5 | Mi 9T calls, nobody answers | after 60 s the ring stops; a missed-call line on both | caller `[Call] ring window (60000 ms) closed unanswered - call=<id>` |
| 6 | The callee app KILLED, then called | **nothing rings - EXPECTED in lot 1**, not a `FAIL` | caller as step 5 |
| 7 | Callee sets "Appels" to "Non autorises", then is called; then back to "Autorises" | refused: no ring, a missed-call line at once; allowed again: it rings | callee: `[Call] invite <id> in <group> not rung - calls are not allowed in this conversation` |
| 8 | **CALL-WIFI** (owed on a build carrying the resume, both phones on it). In a connected call, Wi-Fi OFF on the Mi 9T for **6 s**, then on | the call does NOT end; both screens show "Reconnexion..." only on a build that also carries the call UI of #2138 (it reads `callService.reconnecting`); audio comes back both ways | Mi 9T: `[Call] signalling WebSocket closed code=1006 - resuming`, `[Call] signalling resume attempt N/15`, `[Call] signalling resumed on attempt N`, `[Call] peer ready - ... (resumed)`, `[Call] pair resumed: ... audio packets A -> B`; either `the media path carried audio across the outage - no ICE restart`, or on the INITIATOR `[Call] ICE restart 1/3 (...)` + `[Call] ICE restart offer (...) -> peer` then `[Call] media path restored after 1 ICE restart(s)`; NO `[Call] terminal failure`. Server: `[call] p2p seat away ...` then `[call] p2p paired ... resumed=true`. **`1.3.1-alpha.2`: `PASS`** (2026-10-19, [readings](device-readings-2026-10.md)) |
| 9 | **CALL-WIFI**, the same with a **14 s** outage; then once more as callee (the iPhone calls) | as step 8 | as step 8; record the attempt number that resumed (expected 5, at +15 s on the capped ladder). If the initiator's first restart offer was lost: `rolling back an unanswered offer - its answer can no longer come`. **`1.3.1-alpha.2`: `FAIL`** - resumed at attempt 5 (+32 s), the restart request was dropped as "already in flight", both phones stayed on "Reconnexion..." with no audio; cause and fix (explicit restart offer, rollback, per-pairing guard, capped ladder) on [calls](frontend/modules/calls.md#what-the-131-alpha2-bench-reading-found-2026-10-19-and-the-fix); **re-read owed on the build carrying it** |
| 10 | **CALL-WIFI**, Wi-Fi OFF on the Mi 9T for **90 s** (longer than the 60 s seat grace) | the call ENDS on both phones: the Mi 9T by its attempt budget (~+55 s), the iPhone at most ~90 s after the loss | iPhone `[Call] the other party lost its signalling connection` within ~30 s, then `[Call] the other party left the call room`; server `... held dead (half-open socket)` / `disposition=keepalive-lost`, then `p2p seat EXPIRED`; Mi 9T `[Call] signalling resume refused (call-over)` or `... not restored after 15 resume attempts`. **`1.3.1-alpha.2`: `FAIL`** - the Mi 9T ended at +30 s, the iPhone sat on "Reconnexion..." for 100+ s: the server never held the half-open socket dead, so no grace and no `PeerLeft`; fixed by the keepalive liveness proof; **re-read owed** |
| 11 | **CALL-WIFI keepalive, a SUSPENDED app** (owed on the build carrying #2148): in a connected call, lock the screen on ONE phone for **more than 30 s**, then unlock; again with the app sent to the background instead; each phone in turn | EITHER the call goes on (the app kept running: its process answered the keepalive) OR, if the OS suspended the app, the partner shows "Reconnexion..." about 20-30 s in, then the call ENDS on it ~60 s later; on unlock the suspended phone resumes if it is back before that end, else it is told the call is over. NEVER a partner stuck on "Reconnexion..." past ~90 s | server: no `held dead` line while the app runs; if suspended, `... answered none of 2 keepalive pings - held dead (half-open socket)`, `disposition=keepalive-lost`, then `p2p seat EXPIRED` or `paired ... resumed=true`. Record per phone and per gesture whether the app was suspended: the change of behaviour (a suspended app used to keep its seat "present" indefinitely) is the thing measured. Android's background microphone is CALL-LOCK-ANDROID, not this row |
| 12 | **WP-C-BG-I, the iPhone's microphone in the background** (owed on the first pre-release carrying it, in this order). (a) The iOS job's `UIBackgroundModes of the built app:` line lists `audio`. (b) In a connected call: lock the iPhone 60 s, then send it to the background 60 s. (c) Out of a call - **the mode is APP-WIDE**: play a reel with sound, then a voice message, and lock then background the iPhone during each. (d) In a call: an audio ROUTE change (AirPods connected then removed, a wired headset in and out) and a short interruption (an alarm or a Siri press of about 2 s). (e) A call ACCEPTED from the lock screen (the track can be handed over already muted). Record every `mute`/`unmute` pair with its duration BEFORE any debounce is written | (b) the Mi 9T keeps HEARING the iPhone through the lock and the background (its inbound audio packets keep rising - `getStats()` over CDP every 5 s) and the iPhone keeps playing the Mi 9T's voice. (c) RECORD whether playback continues while locked or in the background - it did not before this build, and now may: that is a behaviour change to accept or refuse, not a defect by itself. (d) a route change should NOT produce a `the system took the microphone` line; if it does, how often and for how long - a flicker would put false "Le telephone de ... a coupe son micro" notices on the partner's screen. (e) the call connects, and if the track starts muted the notice shows until it is given back | iPhone log: NO `the system took the microphone` in (b); in (d)/(e), each `WARN the system took the microphone (track muted, page visible\|hidden) - telling the other party` and `gave the microphone back after N s` with N; Mi 9T log: `the other party's system took its microphone` / `gave its microphone back` for each; server: one `p2p mic-suspended relayed` per transition. If (b) still mutes the capture, read the iPhone's syslog (`WebKit`, `mediaserverd`) before any native audio-session code ([calls](frontend/modules/calls.md#wp-c-bg-i---the-iphones-microphone-in-the-background-2026-10-20)) |
| 13 | **B0 of the audio-only plan - a hidden peer video is still under its transform** (owed on the first pre-release carrying #2171). A dev build WITH video calls a build with video FORCED OFF (`CALLS_VIDEO_ENABLED` false: a local build, or the first audio-only alpha), the video side turns its camera on; once with the iPhone as the audio-only side, once with the Mi 9T | the audio-only side shows NO video and the call goes on past 30 s with the camera on; the video side still hears and is heard | audio-only side: `[Call] the peer sends video - this build is audio only, it is received and not shown`, then `E2E path check ...: no media around the transform` with `received ... video=` rising; NEVER `media flowed AROUND the transform on receiver:video` nor a `CallE2eBypassedError` end. A false END here means the engine does not feed a receiver transform whose track has no sink - then the `inactive` route of B0 is owed ([calls](frontend/modules/calls.md#turning-calls-on-in-production---audio-11-only-owner-2026-10-21)) |

**Record per direction:** the verdict, the `relayed=` value (only `relayed=yes` is billed TURN), the
network (bench Wi-Fi; no SIM in either phone, so cellular stays owed), and the build on each phone.

**Failure signatures, and what each names:**

- `[Call] ICE servers HTTP 503`: the dev TURN pair is missing from dev's chat-delivery-service
  (`DEV_CLOUDFLARE_CALLS_API_TOKEN`, `DEV_CLOUDFLARE_TURN_KEY_ID`), or the monthly budget refused.
- `[Call] startCall refused - RTCRtpScriptTransform unavailable` (or `acceptCall refused ...`): that
  WebView has no E2E transform - a finding about the engine, P1 for lot 1, never a reason to degrade.
- `[Call] WARN remote audio still muted after 5s`, or `[Call] E2E decrypt failed`: media arrives
  but cannot be heard or decrypted; note both phones' MLS state.
- `[Call] ERROR E2E key mismatch` and the "ne peut pas être déchiffré" notice (builds carrying the 2026-10-21 port
  of #2013): no receiver decrypted anything after 100 failures - compare one phone's `send_fp` with
  the other's `recv_fp` (`media keys derived from MLS` line); unequal means the two devices derived
  different keys (different MLS epochs, or one build older than the v2 wire) ([calls](frontend/modules/calls.md)).
- `[Call] signalling refused: <reason>`: the relay refused the room (`room-full`, `group-mismatch`,
  `token-refused`; `call-over` on a resume means the seat expired or the other party hung up).
- `[Call] terminal failure: ... the relay gave no resume token`: the call-service on that estate
  predates the resume (CALL-WIFI) - a deploy gap, not a client defect.
- `[Call] connectionState=failed` with no `selected path`: no candidate pair, not even TURN - read
  `iceConnectionState` and the network.

**`[CALL_REPORT]` reaches a build with the first pre-release carrying the 2026-10-21 port of #2011**
(check the release notes; no build before it has the line). From then on each device logs one line per call every 10 s and once at the end
(`[CALL_REPORT] call=<roomId> phase=<tick|end> dur_ms= setup_ms= engine= ice= pair= relayed= ...
e2e=on enc_frames= dec_frames= dec_fail=`); record `setup_ms`, `relayed`, `rtt_ms`, `loss_in_pct` and
`dec_fail` per direction, which is the plan's exit criterion
([calls-revival-plan](frontend/modules/calls-revival-plan.md)).

## The Mi 9T readings of v1.2.9-alpha.7 (2026-10-17)

Build `1.2.9 (100200907)`, the `v1.2.9-alpha.7` release APK (`app-universal-release.apk`, sha256
`b3a5129c...`, release run `39026972985` green), `adb install -r` over alpha.5 (`firstInstallTime`
unchanged: enrolment kept). Dev estate, account `fourth` ("Canari Test Delta", NOT an admin), vault
path, phone text size `0.85`. Console over CDP, real taps with `adb input`. Evidence:
`<harness-dir>/a1-bench/r1017-a129a7/` (`hubnav.ndjson`, `weaknet-runs.ndjson`, `wn1-3.txt`,
`signout.json`, `cons-all.ndjson`, `cons-fs.ndjson`, frames `s*.png`).

| Reading | Verdict | What was seen |
| --- | --- | --- |
| 1. Comment sort row at 200 % text (#1980) | **`PASS`** | `font_scale 2.0` (root 32 px). "Recents / Anciens / Aimes" now sit on their own line UNDER "Afficher les 2 commentaires" (R 351 for a 436 px viewport). `.page-scroll-wrap` `scrollWidth 436 = clientWidth 436` (alpha.5: 553), `documentElement` 436; a `scrollIntoView` on "Anciens" and a real sideways drag both leave `scrollLeft` at 0 (`s10-fs2-sortrow.png`). The only boxes wider than the viewport are long author names, clipped inside their `truncate` parent |
| 2a. Dashboard hub rows (#1958) | **`PASS`** | `/dashboard` from the fourth tab: the identity row ("Voir mon profil"), **Explorer** (Agenda, Associations, Listes, Institutions, Boutique, Formulaires, Notifs), then **Compte** (Parametres, then "Se deconnecter" in the danger tone) - the order #1958 specifies; "Compte" is the LAST group, not the first. No admin or manager group for this account (`s01`, `s02`) |
| 2b. Each row navigates, Back returns | **`PASS`** | Real tap on each of the 9 link rows: `/profile`, `/calendar`, `/associations`, `/lists`, `/institutions`, `/shop`, `/forms`, `/notifications`, `/settings`, each with its own `h1`; ONE system Back returns to `/dashboard` 9 of 9 (`hubnav.ndjson`) |
| 2c. Dashboard at 200 % text | **`PASS`** | `scrollWidth 436`, 0 clipped rows, labels and summaries wrap on two lines (one summary ends in an ellipsis after two lines, by design); scrolled to the end the sign-out row (bottom 832) clears the tab bar (top 873) (`s11`, `s12`) |
| 2d. Sign-out busy state, double tap (#1958, #1966) | **`PASS`** for the button, **see the finding below** | Two `input tap` 191 ms apart: ONE `[A] signout requested by the user`; the row reads `disabled`, `aria-busy="true"` at the next sample, then `/login`. But TWO `POST /api/auth/logout` went out (200 each) - the second NOT from the second tap |
| 2e. Theme still reachable | **`PASS`** | Parametres > Preferences: "Automatique / Clair / Sombre"; Clair sets `data-theme="light"` (body `rgb(240, 242, 245)`), Automatique returns to dark |
| 3. Admin read-access redesign (#1957) | **`NOT-OBSERVED`** | `fourth` is not an admin (`canari_global_admin` false, no Administration group) |
| 4. Airplane mode during a refresh (#1966) | **`PASS`** (n=3 cold, n=1 warm) | Cold start, airplane ON 0.75 s after launch, held 35 s, then OFF. n=2 with the refresh in flight: `refresh->` then `refresh✗transport 111-112ms`, `refresh not sent: the browser reports no network ... held until the reconnect`, `[LOGIN] Offline unlock (no token)`; network back: one more transport failure, then `refresh✓`, `[PROMOTE] ... fully promoted` 46 s after the cut. Route `/posts` throughout, the login page never drawn. n=1 with the cut after `refresh✓`: same, no sign-out. Warm (feed open, airplane on, pull to refresh, 30 s): "Hors connexion.", back online `server reachable again`, no `[A]` line. **Airplane mode fails the request in ~110 ms: the 20 s `REFRESH_DEADLINE_MS` path (a stalled link) was NOT exercised** |
| 5. Avatar photo on the first frame (#1977) | **`NOT-OBSERVED`** | As on alpha.5: no conversation, community or member reachable from `fourth` has a photo avatar (0 `<img>` avatars on `/chat` and `/communities`) |
| 6. `[TAURI] Couldn't find callback id` after a text-size change | **`PASS`** | Text size 0.85 -> 2.0 (the WebView reloads: `Initialised in TAURI mode`): **0** such warnings in the 3 min after, 0 in 210 s, 0 in logcat, 0 across the three force-stop relaunches of reading 4 (alpha.5: 15 in 4 min). The console logger was proven alive by a probe line |

**Findings:**

- **P2 - a user sign-out sends `POST /api/auth/logout` TWICE and ends through the "session
  expired" path.** `signout.json`: `[A] signout requested by the user`, `[A] clear`, `[LOGOUT] MLS
  client retired`, the page re-initialises, and `[PIN] Device key restored from PinVault -
  auto-login...` runs AGAIN (17 ms after) - the vault surviving a sign-out, noted on 2026-10-14. That
  auto-login asks for a token: `refresh->` races the logout, comes back `refresh✗401`, and
  `[AUTH] Session expired - logging out and redirecting to /login?returnTo=%2Fdashboard` runs a
  second `clear` and a second logout POST. The reader lands on `/login?returnTo=/dashboard`.
- **Observed, documented:** `signout: MiConnect session NOT ended (no-id-token)` - this session
  predates the id_token kept by #1866, so its first sign-out is local-only, as
  [auth](frontend/modules/auth.md#signing-out-ends-the-miconnect-session-2026-10-14) says. The
  following sign-in asked for the password.
- **The 2026-10-14 P1 candidate did NOT reproduce:** sign-in again in the same process
  (service-account link, password) reached `handleOidcCallback resolved`, the vault restore, the
  device binding (`PUT .../sessions/current/device` 200), the feed and the DM list, no kill needed.
- **P3 noise:** while the refresh is held offline, `[A] token->refresh` is logged 43-44 times in the
  first 13 s of a cold start (one per caller). Offline `[WS] Gateway connection failed` at ERROR,
  unchanged.
- Logcat: no `FATAL EXCEPTION`, no ANR. The phone is left at text size `0.85`, airplane mode off,
  signed in as `fourth` on the vault path.

## The Mi 9T readings of v1.2.9-alpha.5 (2026-10-17)

Build `1.2.9 (100200905)`, the `v1.2.9-alpha.5` release APK (`app-universal-release.apk` by asset
id, sha256 `96b09481...`), `adb install -r` over alpha.4 (`firstInstallTime` unchanged: enrolment
kept; Play Protect's "send for a check" prompt answered "Ne pas envoyer"). Dev estate, account
`fourth` ("Canari Test Delta"), vault path, bench DM with gamma only. Console over CDP. Evidence:
`<harness-dir>/a1-bench/r1017-a129a5/` (`cons-all.ndjson`, `cons-2.ndjson`, frames).
#1977 (warm avatar cache) is NOT in this tag.

| Reading | Verdict | What was seen |
| --- | --- | --- |
| 1. A gallery video in a chat opens 3 times and plays | **`PASS`** | A 9 s gallery video sent in the DM (prepared 13.8 MB -> 3.2 MB, segmented upload). Opened full screen 3 times in a row (tap off the centre "Lire" button), closed with Back each time: each open has a second `<video>` at 436 px, `readyState 4`, playing (`currentTime` 1.26-1.56 s at +1.5 s, 3.45-3.72 s at +3.5 s), no media error; Back returns to `/chat` with the viewer gone. A tap on the centre button plays inline instead (`InlineVideo: manual play`), by design |
| 2. ReelBackdrop on the camera paints, then repaints once exposure settles | **`PASS`** | `/camera` from the feed swipe: `[reel-backdrop] painted`, then `repainted once the exposure settled (4 reads, 32 frames)` 1.5 s later; after a lens switch `painted` then `(2 reads, 16 frames)` 0.6 s later. The backdrop canvas is 96x168 shown at 436x861, opacity 0.6. In the reel viewer it paints on open and again on the next reel |
| 3. Feed "Tout" at 200 % text | **`FAIL` (P3)** | `font_scale 2.0` (root 32 px). Tab row fine (a scroller; Tout and the CanaReels icon stay in view), names truncate, `documentElement` does not overflow. **But the comment sort row (Recents / Anciens / Aimes, beside "Afficher les N commentaires") does not wrap: `.page-scroll-wrap` gets `scrollWidth 553` for `clientWidth 436`** (`overflow-x: auto`), so the whole feed can be shifted 117 px sideways; a `scrollIntoView` on "Anciens" did exactly that (`t200-sort.png`). 17 px over already at 150 %, none at 100 % or 85 % |
| 4. Posts page tabs and the CanaReels entry | **`PASS`** | Associations / Suivis / Tout each set `?feed=` and draw their list (Suivis: the "Aucun post" empty state). The clap icon opens the viewer at the newest reel (`page of 4, 4 loaded`), playing, author and text over the scrim, a swipe goes to the next reel, the close returns to `/posts?feed=all` |
| 5. Avatars when switching chats | **`NOT-OBSERVED` for photos** | No conversation or member reachable from this account has a photo avatar (0 `<img>` avatars). Initials avatars sampled every frame across DM -> back -> community -> DM (986 frames): 0 frames with an empty avatar |

**Met on the way:**

- **A system text-size change reloads the WebView, and afterwards `[TAURI] Couldn't find callback id
  2851905282 ...` is logged as a warning every ~15 s** (15 times in 4 min, same id), an async Rust
  call still answering the page that went away. Noise by the project rule (P3).
- The video staged in the composer shows a generic file icon and the name `81.mp4`, not a preview
  or the gallery name; the sent bubble shows a grey video icon until tapped (P3, cosmetic).

## The Mi 9T readings of v1.2.9-alpha.4 (2026-10-16)

Build `1.2.9 (100200904)` (`dumpsys package`; "Version de Canari 1.2.9-alpha.4" in
`/settings/about`), the `v1.2.9-alpha.4` release APK (`app-universal-release.apk`, sha256
`b58e4aa7...`) from release run `38888170609`, installed with `adb install -r` over alpha.3
(accepted, account kept), dev estate, account `fourth` ("Canari Test Delta"), phone text size
`0.85` (its default). Same instruments as alpha.3 (`feed.mjs`, `reconnect.mjs`, `st.mjs`, console
over CDP, logcat), plus `reelperf.mjs` (in-page: `requestAnimationFrame` deltas over 5 s, then the
playing reel's `requestVideoFrameCallback` across two loops) and `cap.mjs` (the caption toggle, its
scroller, whether the reel plays). Two dev reels were published to have a long caption and a
landscape frame (a 6 s in-app take, and a 1280x720 test pattern from the gallery), both deleted at
the end (`DELETE /api/posts/...` 200 each); nothing was published on production. Evidence:
`<harness-dir>/a1-bench/r1016-a129a4/` (frames `s*.png`, `reelperf.ndjson`,
`feed-runs.ndjson`, `reconnect-runs.ndjson`, `cons-main.ndjson`, `applog.txt`, `logcat-main.txt`).

| Reading | Verdict | What was seen |
| --- | --- | --- |
| 1a. One header row (#1942) | **`PASS`** | "Associations", "Suivis", "Tout", then the clap icon at the right ("Ouvrir les CanaReels"); no "Tous les posts" / "CanaReels" filter row; `[POSTS] dropped the retired CanaReels filter choice` once (`s01-feed.png`) |
| 1b. Clap opens the viewer | **`PASS`** | `[reels-entry] opening the viewer at the newest reel`, `[reel-viewer] opened on af19ba1b...`, `page of 3, 3 loaded`; full screen, the feed hidden under it (`s02-viewer.png`). Drag up: `next: 0 -> 1`. ONE system Back: `[reel-viewer] closed`, `/posts`, no dialog left, `history.length` unchanged |
| 1c. Empty state | **`NOT-OBSERVED`** | Every dev account sees the same reels (`feed=all`); reaching "Pas encore de CanaReels" needs deleting other members' reels, which was not done |
| 2a. Overlay, default text | **`PASS`** | Avatar + name + age small at the bottom-left over a scrim; a 9-line caption clamped to 2 lines with "Voir plus" (`s10-viewer-new-reel.png`). "Voir plus" unfolds in place (`caption expanded on f3bbee49...`), "Voir moins" and a tap on the video both fold; the reel plays throughout (`currentTime` advancing and looping, never paused) |
| 2b. Overlay at 200 % text | **`PASS`** | `font_scale 2.0`, root 32 px: unfolded, the caption is a scroller (473 of 1485 px) under the author row with "Voir moins" visible; a drag scrolled it (`scrollTop` 0 -> 377) without turning the reel, the reel playing (`s14`, `s15`). Restored to `0.85` |
| 2c. Landscape (letterboxed) reel | **`PASS`** | `[reel-review] take is 1280x720`, `ratio 1.778`: the frame sits mid-screen, the caption inside it, 2 lines + "Voir plus"; unfolded it scrolls inside the frame (112 of 210 px, `scrollTop` 0 -> 84), author row and toggle never clipped (`s19`, `s20`) |
| 3a. Backdrop | **`PASS`** | A 96x56 / 96x168 canvas, `object-fit: cover`, no CSS filter; `[reel-backdrop] painted` exactly once per source, no timer. Smooth gradient, no blocks (`s19-landscape-viewer.png`) |
| 3b. Frame timing while a reel plays | **`PASS`** | n=3 x 5 s: 302-304 frames, p50 16.6-16.7 ms, p95 16.8 ms, longest 17.0-33.6 ms, frames over 25 ms **0, 1, 0** (alpha.3 bench: 5 over 25 ms with the 250 ms re-sample) |
| 3c. Loop seam | **`PASS`** for a reel published by alpha.4, residual noted | Video frames every 33 ms. **Trimmed reels** (published now, `[video-prep] trimmed to the video: 0.055-6.063 s`): last frame -> first frame after the wrap **100-117 ms**, first frame held **67-83 ms** (n=4 wraps, portrait and landscape). **Old untrimmed reel** (`af19ba1b`, 3.52 s): 100-133 ms, then the first frame held **250-267 ms** (n=5; 383-417 ms on alpha.3) |
| 4a. Camera photo name | **`PASS`** | Edited photo: `handing back canari-photo-<n>.webp (44600 bytes)`, `camera take handed over (image/webp)`. Unedited: `canari-photo-<n>.jpg`. No `.bin` |
| 4b. Camera preview backdrop | **`FAIL`** | Post composer camera, n=3 opens: the backdrop canvas reads near black (mid/bottom rows RGB 2-6) while the preview shows a grey wall; the band under the preview is RGB 16,15,16 (`s22`, `s30`, `s31`). Painted 166 ms after `[camera] first frame`, from an under-exposed first frame. On `/camera` the same paint came out teal over the grey wall (`s06b`) |
| 5. Paid form price (#1938) | **`PASS`** | "Cotisation BDE 2026" by its id: before any answer, no "Combinaison indisponible", no price, no "Payer" (`s40`). After "ICM": "A partir de 60,00 EUR (3A, ICM)", "Paiement Canari" / "En especes", "Payer 60,00 EUR" (`s41`). Nothing paid |
| 6a. Feed after reconnect (#1938) | **`PASS`** | n=2 offline cold start, then airplane off: **20 cards offline and 20 after** (alpha.3: 10); the status line goes at +6.3-7.3 s, the reel decodes at +8.4 s |
| 6b. Reel stream once (#1938) | **`PASS`** | One `[media-seg] stream ... through MediaSource` per cold start (n=3 online, n=2 reconnect), no `play() refused` |
| 7a. Wrong PIN empties the field | **`NOT-OBSERVED`** | As on alpha.3: the vault restores the key on every launch, the gate is never drawn |
| 7b. Online cold first paint | **`PASS`** | n=3: first card **2558-3092 ms** after `am start` (alpha.3 2254-2385), 20 cards, 0 warnings |
| 7c. Offline cold start noise | **`PASS`**, unchanged | n=3: **10** warnings each, the same ten families |
| 7d. 200 % text | **`PASS`** | `/posts` `scrollWidth = innerWidth = 436`; the tabs scroll in their own row |

**Findings:**

- **P1 - a video picked from the gallery on `/camera` (Android) is dropped without a word.** The
  picker opens (`GET_CONTENT video/*`), the app goes to the background, the camera is released and
  `CameraScreen` drops its `controls` snippet with the `<input type="file">` in it. The file comes
  back to that DETACHED input (`isConnected: false`, `files[0] = 96.mp4, video/mp4`), and Svelte 5
  delegates `onchange` from the root, so `onPicked` never runs: no review, no toast, no log line
  (n=3). Handing the same file to the live input reached `ready -> review on picked`, which is how
  the landscape reel was made. Source: `frontend/src/lib/components/reels/ReelCapture.svelte`
  (the input inside `{#snippet controls()}`).
- **P3 - the camera backdrop is painted from the first frame, before exposure settles**: near black
  in the post camera (3 of 3), teal on `/camera`. The live preview is grey.
- **P3 - an old reel still holds its first frame 250-267 ms at the loop** (published before the
  trim); new reels 67-83 ms.
- Observations: at `font_scale 2.0` the selected "Tout" tab sits under the clap icon until the tab
  row is scrolled (`s12-fs2-feed.png`); a system text size change reloads the page (the open viewer
  closes). In-app log export: 24198 lines, 2147637 bytes, `[download] wrote ...`; its W/E lines of
  the session are all the offline runs' transport failures. Logcat: no `FATAL`, no ANR; 99 `Ignoring
  status update of camera`, 34 `Failed to query component interface for required system resources:
  6` (codec stack).

## The Mi 9T readings of v1.2.9-alpha.3 (2026-10-16)

Build `1.2.9 (100200903)` (`dumpsys package`), the `v1.2.9-alpha.3` release APK
(`app-universal-release.apk`, sha256 `935dabda...`, tag commit `a5066d8e2`), installed with
`adb install -r` over alpha.2 (accepted, account kept), dev estate (deployed by the same release
run), account `fourth` ("Canari Test Delta"), bench conversations only, vault path. The phone uses
gesture navigation (`navigation_mode 2`, system Back zones 0-74 px and 1006-1080 px). Same
instruments as alpha.2 (`feed.mjs`, `reconnect.mjs` with its media probe narrowed to `main img`
wider than 150 px and `main video`, console over CDP, logcat), plus `st.mjs` (route, open
conversation, open dialogs, live camera, `history.length`). To give the dev feed media, ONE image
post (in-app camera photo) and ONE CanaReel (a 9.6 s take from the `/camera` swipe place) were
published, then both deleted at the end (`DELETE /api/posts/...` 200 each). Evidence:
`<harness-dir>/a1-bench/r1016-a129a3/` (frames `s*.png`, `feed-runs.ndjson`,
`reconnect-runs.ndjson`, `cons-*.ndjson`, `logcat-main.txt`).

| Reading | Verdict | What was seen |
| --- | --- | --- |
| 1a. CanaReels filter viewer (#1920) | **`PASS`** | Filter "CanaReels": the new reel first, then the two dev reels. A tap on the reel opens the viewer full screen ON that reel, playing (`[reel-viewer] paging the filtered feed "all" from <its publishedAt>`, `opened on 48e7a896...`, `page of 2, 3 loaded`). Drag up: `next: 0 -> 1` (the text-only dev reel); drag down: `prev: 1 -> 0`. ONE Back: `[reel-viewer] closed`, `0 left open`, the feed is still on "CanaReels" + "Tout" |
| 1b. Media after offline -> online (#1922) | **`PASS`** | n=2, offline cold start then airplane off at t=0: the status line goes and the refreshed page draws at **+6.2-6.3 s**; the photo is loaded (`complete`, `naturalWidth > 0`) at the same sample and the reel's video decodes (`readyState >= 2`) at **+8.2-8.3 s**. Offline, before the refresh, neither media is drawn: the cards show "Reessayer" (`[FEED-STORE] ... drawn, unconfirmed`) |
| 2a. Chat "+" menu / camera / review Back (#1925, Android unchanged by #1936) | **`PASS`** | One press per layer, `st.mjs` after each: "+" menu open -> Back 1 closes the menu, conversation kept. Camera (no take) -> Back 2 closes the camera. Photo review -> Back 3 shows "Abandonner cette capture ?" over the review; "La garder" keeps it; Back 4 the dialog again; "Abandonner" -> live camera; Back 5 closes the camera (`Back closes the camera (chat)`); Back 6 closes the conversation. Never two layers for one press |
| 2b. Salon row after Back | **`PASS`** | Bench community, "general": open, Back, n=3: the row's background stays `rgba(0, 0, 0, 0)`, not focused, no `aria-current` |
| 3. Editor edge gestures (#1936) | **`PASS`** | Reel editor (the `/camera` take) and the photo editor (post composer). Paint strokes starting at x = 120, 90 and 80 px draw and the editor stays. A stroke starting at x = 3 or 40 px is inside Android's own Back zone: it is a system Back (`[swipeBack] touch cancelled`, `Back with the editor open: the editor decides`) - with no edit the editor closes to the review, with an edit it asks "Abandonner vos modifications et revenir a la capture ?" and "Continuer a modifier" keeps them. A sticker dragged to the edge stops at x = 129 px; dragged back from there: reel editor 6 of 6 move, editor never left; photo editor 2 of 6 did not move (no log line, editor stayed), not reproduced afterwards |
| 4. PIN change, relaunch (#1935) | **`PASS`** | `Re-sealed under the new device key: messages=734 seeds=11 outbox=0; already new=0, unreadable=0, changed since read=0`, `2 stored feed page(s) dropped`, "PIN modifie" in 1.6 s. Kill and relaunch: `Device key restored from PinVault`, no keypad, the DM opens with 54 bubbles and 0 undecrypted, 0 warnings. Changed back: the same counts |
| 4b. Wrong PIN empties the field (#1935) | **`NOT-OBSERVED`** | The Android vault restores the key on every launch, so the PIN gate (`showPinGate`) is never drawn; reaching it needs a refused or missing vault, which was not destroyed for this |
| 5a. Online cold first paint | **`PASS`**, unchanged | n=3: first card **2254-2385 ms after `am start`** (page 1641-1693 ms; alpha.2 2397-2798). `[POSTS] stored first page drawn: 20 posts read in 345-372 ms`; the stored-copy line stays 0.39-0.57 s |
| 5b. Offline cold start noise | **`PASS`**, unchanged | n=3: **10** warnings each, the same ten families as alpha.2 |
| 6. Forms smoke (#1916/#1930) | **`PASS`** | The one paid form on dev ("Cotisation BDE 2026", private, opened by its id): `GET /api/forms/<id>`, `.../calendar-link`, `.../check` all 200, no crash, 0 warnings. Choosing "ICM" shows "Paiement Canari" / "En especes" and "Payer 60,00 EUR". Nothing paid |

**Findings:**

- **P3 - the paid form says "Combinaison indisponible" before any answer is chosen** (the banner,
  the footer and the button), with the price only after the first choice (`s51-paid-form.png`).
- **P3 - the feed mounts the reel's stream twice on a cold start**: two `[media-seg] stream ...
  through MediaSource` lines 133 ms apart, then `[video] playWhileVisible: play() refused` (once per
  cold start that draws the reel).
- **P3 - a camera photo is handed over as `canari-photo-<n>.bin`**: `[reel-capture] a take of an
  unknown type "image/webp" - named .bin`. The post published and showed the photo.
- **P3, still open from alpha.2 - back online, the refreshed feed shows 10 cards** where the stored
  page showed 20, and that page of 10 is now what the next offline start draws.
- **P3 - the URL does not carry the filter**: `location.search` is empty on "CanaReels", where
  [reels](frontend/modules/reels.md) decision 3 says a choice writes `kind=reel` into the URL. The
  filter still holds across the viewer and the cold starts.
- Observations: the dev banner covers the status bar on `/camera` (`s15-camera-tab.png`); a reel
  with no media shows a play button that plays nothing in the viewer; the bench salon logs `6
  message(s) of 87ac63f9 are unreadable - missing seed` (old bench history). Logcat: no `FATAL`, no
  ANR; 90 `Ignoring status update of camera` (Chromium camera stack).

## The Mi 9T readings of v1.2.9-alpha.2 (2026-10-15)

Build `1.2.9 (100200902)` (`dumpsys package`), the `v1.2.9-alpha.2` release APK
(`app-universal-release.apk`, sha256 `b3fcc8e2...`, tag commit `adf0b419d`), installed with
`adb install -r` over alpha.1 (accepted, account kept), dev estate, account `fourth` ("Canari Test
Delta"), bench conversations only, vault path. Offline means airplane mode (the phone has no mobile
data). Same instruments as alpha.1 (`feed.mjs`, console over CDP, logcat for the whole pass), plus
`reconnect.mjs` (offline cold start, 10 s, airplane mode off, 40 one-second samples) and `frames.mjs`
(the `mediaTime` of every presented frame of a take). Evidence:
`<harness-dir>/a1-bench/r1015-a129a2/` (frames `s*.png`, `feed-runs.ndjson`,
`reconnect-runs.ndjson`, `cons-camera.ndjson`, `frames-video1.json`, `logcat-main.txt`).

| Reading | Verdict | What was seen |
| --- | --- | --- |
| 1a. Offline cold start noise (#1921) | **`PASS`** | n=3, same window as alpha.1: **10** warnings each (alpha.1: 68-70). One line per family: `[A] refresh✗transport` once, `[LAYOUT] Profile check did not answer` (twice, P3), revocation check, `push_context` write, `[DISPLAYNAME] profile lookups get no answer` once, `[FEED-STORE] ... drawn, unconfirmed`, `[History] batch ... got no answer`, `[HISTORY] no answer for group ...`, `[PENDING] ... UNDRAINED and stays queued`. No `getToken failed ... proceeding without auth`, no page-size halving, no `[GRAINE] asked <self>`. Feed drawn from the device (20 cards, 2432-2699 ms after `am start`), never "Impossible de charger" |
| 1b. Back online without a restart (#1922) | **`PASS`** (refresh); media `NOT-OBSERVED` | Airplane off at t=0: `[CONNECTIVITY] browser reports online` +4.2 s (the radio), `server reachable again` +5.7 s, `[POSTS] server reachable again - the first page is asked again`, `200 GET /api/posts` +6.2 s; the status line is gone at the +7.2 s sample. `[PROMOTE] Access token acquired` at the same moment. **No post on the dev feed carries an image or video** (40+ cards of "Tout" and both reels scanned: no media element; the reels' API rows have `images: []`), so "media show after reconnect" could not be seen |
| 1c. Online cold first paint (#1922) | **`PASS`** for the stored-copy hang; first card **not** under 1 s from launch | n=4: first card **2397-2798 ms after `am start`** (page 1779-2135 ms; alpha.1 2465-2973). The "Fil enregistre..., mise a jour..." line now stays **0.24-0.54 s** (alpha.1: 3.0-3.6 s), and in 1 run of 4 the server answer came first (`stored first page read after the server answered - not drawn`). `[POSTS] stored first page drawn: 20 posts read in 333 ms`; `<- 200 GET /api/posts` ~0.5 s after. The PR's 650-736 ms was a reload of a warm process; from a cold launch, the app's own boot dominates |
| 2. CanaReels filter (#1920) | **`PASS`** (filter, relaunch); viewer `NOT-OBSERVED` | "Tous les posts" / "CanaReels" row under the header; CanaReels -> `GET /api/posts?...kind=reel` (`[POSTS] feed filter: all -> reel`), 2 reels listed; relaunch keeps "CanaReels" selected (stored page of 2 drawn). The row holds at 200 % text. **The two dev reels have no video** (`kind: reel`, `durationMs: 2219`, `images: []`), so the cards draw text only and a tap opens nothing: open / swipe to the next / return could not be read. Restored to "Tous les posts" |
| 3a. Chat camera Back (#1925) | **`PASS`** | "+" > "Ouvrir la camera", photo. Back 1: "Abandonner cette capture ?" OVER the review; "La garder" keeps it (`discarding the review: kept`). Back 2: the dialog again; "Abandonner" returns to the live camera. Back 3 closes the camera (`Back closes the camera (chat)`), the conversation stays. Back 4 closes the conversation. Logs `historyOverlay ... Back landed on an entry no overlay above owns - closing the top one` twice (P3, below) |
| 3b. Post composer video (#1925) | **`PASS`** | 3.5 s hold: `recording video/webm;codecs=h264,opus`, `take: 967955 bytes, video/x-matroska;codecs=avc1,opus`, `canari-video-*.mkv`, `[capture-poster] ... 3128-byte thumbnail attached`; the composer tile shows the frame, not a grey tile. Back closes the composer; reopening shows "Brouillon restaure (texte, options et medias)" with the video. Draft cleared afterwards, nothing published |
| 3c. Refused camera, fresh permission (#1925) | **`PASS`** | `pm revoke` + flags cleared; chat camera: ONE system dialog, "Ne pas autoriser", no second dialog in the next 6 s (focus stays on Canari). `app away with an open in flight - its answer is awaited`, `refused (denied)`, `back on screen in error - nothing to reopen`. Text: "Canari n'a pas acces a la camera" / "Autorisez la camera pour Canari dans les reglages du telephone, puis reessayez." (no microphone). Permission granted back afterwards |
| 3d. First frames of a take | **`PASS`** | The 2.975 s take plays 63 frames; first presented `mediaTime`s 0.003, 0.033, 0.100, 0.227...; largest gap 127 ms, spread over the whole take (a dim, still scene at ~21 fps), no hold at the start |
| 4. PIN change then relaunch (#1898) | **`PASS`** | `Re-sealed under the new device key: messages=734 seeds=11 outbox=0; already new=0, unreadable=0, changed since read=0`, plus `3 stored feed page(s) dropped - the next feed answer rewrites them`, "PIN modifie" in 1.6 s. Kill and relaunch: `Device key restored from PinVault`, no PIN prompt, the DM history decrypted, 0 warnings. Changed back: the same counts |
| 5. 200 % text and noise | **`PASS`** | `font_scale 2.0`: root 32 px, `/posts`, `/communities`, `/chat`, `/settings/about`, `/dashboard` all `scrollWidth = innerWidth = 436`; the only element past the edge is a truncated author name inside its `overflow: hidden` card. Restored to `0.85`. The whole online pass (1465 console lines): 2 warnings, the refusal itself and one `[TAURI] Couldn't find callback id` after a relaunch. Logcat: no `FATAL`, no ANR |

**Findings:**

- **P3 - back online, the refreshed feed shows 10 cards where the stored page and every cold start
  show 20** (`reconnect-runs.ndjson`: 20 -> 10 at the refresh, still 10 at +37 s). More may load on
  scroll; whether the reconnect path asks a smaller first page was not read.
- **P3 - the dev estate cannot read media in the feed**: no post carries an image or video, and the
  two reels come back with `images: []`. The reel viewer (#1920) and media after reconnect (#1922)
  need a reel published on dev, or another bench.
- **P3 - `[LAYOUT] Profile check did not answer` is logged twice** within 14 ms on an offline start.
- **P3 - the overlay history stack heals itself on Back**: `Back landed on an entry no overlay above
  owns - closing the top one`, then `1 left open` after the camera closed and `0 left open` with the
  conversation. The user-visible order is right; the stack and the history disagree by one entry.
- Logcat, camera stack (Chromium's, unchanged): 117 `Ignoring status update of camera`, 12
  `BLUETOOTH_CONNECT permission is missing`, 3 `cr_VideoCapture` lines.


## The Mi 9T readings of v1.2.9-alpha.1 (2026-10-15)

Build `1.2.9 (100200901)` (`dumpsys package`), the `v1.2.9-alpha.1` release APK
(`app-universal-release.apk`, sha256 `651f740e...`), installed with `adb install -r` over `1.2.8`
(accepted, account kept), dev estate, account `fourth` ("Canari Test Delta"), bench conversations
only, vault path. Settings > A propos reads "Version de Canari 1.2.9-alpha.1". The app console was
streamed over CDP and logcat captured for the whole pass. Evidence:
`<harness-dir>/a1-bench/r1015-a129/` (frames `s*.png`, `cons-*.ndjson`,
`logcat-main.txt`, `co-banc1/`, `feed-runs.ndjson`, `heart-runs.ndjson`, `flicker.txt`).

| Reading | Verdict | What was seen |
| --- | --- | --- |
| 1. In-app camera everywhere (#1859) | **`PASS`, two findings** | Chat "+" > "Ouvrir la camera" and the new-post composer's "Ouvrir la camera" both open the in-app layer (`[camera-overlay] open for chat` / `for post`); focus is only ever Canari or the system permission dialog, no capture intent in logcat; "Photo/video" still opens the system photo picker. Chat: `opening user (no microphone)`, no microphone prompt; a 2 s HOLD gives a photo, not a video; "Ajouter" stages `canari-photo-*.jpg` (122 KB) as "1 fichier en attente", send gives an image bubble with its check mark. Camera refused: "Canari n'a pas acces a la camera" with "Reessayer" / "Ouvrir les reglages", no native fallback. Post: the microphone is asked at open; refused, `live with no microphone (post): photos only`, not asked again; granted, a 3 s hold records `video/webm;codecs=h264,opus` (1.07 MB) and "Ajouter" attaches it; the review has no sound button. The post was not published |
| 2. Right-edge exclusion (#1883) | **`PASS`** | `right-edge gesture exclusion: span=(292, 2152) -> ExclusionBand(left=987, top=1657, right=1080, bottom=2152)`; `dumpsys window` shows the same rect. The band follows the list: (292, 1949) with the reply bar, (292, 1757) with the keyboard up. Swipes from x=1070-1078 inside the band: 5 of 5 keep the conversation open; on an own bubble, 3 of 4 arm "Repondre a Canari Test Delta" (the miss was a 200 ms swipe), including with the keyboard open. Above the band (y=900) the system back still closes the conversation |
| 3. Back closes the message sheet (#1817) | **`PASS`** | Long press opens the sheet (reactions + Repondre / Transferer / Copier / Modifier / Supprimer); `KEYCODE_BACK` (2 of 2) and a left-edge back swipe (1 of 1) close the sheet only, the salon stays with its 54 bubbles and `history.state` returns to the conversation's entry |
| 4. Avatars without a photo (#1840) | **`PASS`** | Launch + hub + a 62-bubble salon: **0** avatar image requests, **0** `404` (CDP `Network` and the `[API]` lines); 9 `GET /api/users/avatar-presence`, each answered 200, and `[AvatarPresence] N of N have no photo - not requested`. P3: 7 of the 9 asked about ONE face, so the per-turn batching merges less than the PR's 30-in-1 test suggests |
| 5. Feed local-first (#1896) | **`PASS` offline, two findings online** | Offline cold (Wi-Fi and data off, n=4): the first card is drawn **2454-2561 ms after `am start`** (page 1781-1855 ms) from the device, 20 cards, "Fil enregistre sur l'appareil : pas de reponse du serveur." with "Reessayer", never "Impossible de charger". Online cold (n=7): first card **2465-2973 ms** after `am start` (page 1777-2189), the stored copy drawn every time. Warm (Feed tab tap from Communautes, n=4): **230-289 ms** touchstart to first card, from the in-memory cache. Heart during the first load (2 of 2): tapped on the stored copy while "mise a jour..." showed, `201 POST .../reactions`, then `[PostCardLedger] post 6c736e01: kept reactions over a row read at ...`; the count stays 1 |
| 6. Communities first mount and tabs (#1897) | **`FAIL` against 200 ms, better than 1.2.8, no flicker** | `community-open.mjs --community BancOuverture-1 --runs 6 --start cold --net none --cpu 1`, medians (worst): nav 1139, **tap>rail = tap>salons 384 (406)** [1.2.8 base 415-456], tap>target salons 717, salon>pane 304, salon>msgs 1048, switch>salons 158, **reopen>msgs 919 (967)** [965-1020]. Flicker watch (`flicker.mjs`, every frame's bubble count from the touchstart, 6 reopens of the same salon from the hub): first bubbles **237-265 ms**, counts `0 -> 20 -> 60`, **0 blank frames after the first bubble**: the stored page is not followed by an empty frame, so the instrument's ~920 ms reopen is not a flicker |
| 7. PIN change then relaunch (#1898) | **`PASS`** (change path; recovery not exercised) | Bench PIN to a temporary PIN and back, both in Settings > Securite: `[DEVICEKEY_CHANGE] Re-sealed under the new device key: messages=733 seeds=11 outbox=0; already new=0, unreadable=0, changed since read=0`, then `MLS state re-sealed`, "PIN modifie" in 1.6 s. Kill and relaunch: vault path, no PIN or recovery prompt, salon 63 bubbles (the photo of reading 1 included), DM 54 bubbles, the same 8 `[GRAINE] ... no-seed-held` asks as before the change (no seed lost). The outbox was empty, so a queued row's re-seal was not read. The other devices of `fourth` (W3) must re-enter the PIN |
| 8. 200 % text (Android) | **`PASS`** | `font_scale 2.0`: root font 32 px; `/posts`, `/communities`, `/chat`, `/settings/about`, `/dashboard` all `scrollWidth = innerWidth = 436`; the only elements past the right edge are the feed's chip rows inside their own horizontal scroller. Restored to the phone's `0.85` |

**Findings:**

- **P2 - Back from a camera review closes the camera first, then asks.** In chat, Back on a taken
  photo logs `[camera-overlay] Back closes the camera (chat)` and `camera-session stop`; the
  "Abandonner cette capture ?" dialog then shows over the conversation, and "La garder" keeps
  nothing (`the discard question was answered after the camera closed`), 2 of 2. The overlay's own
  comment promises "Back ends a recording, then discards a review, then closes the camera". The X
  on the review asks with the review still behind it, as designed.
- **P2 - A refused camera is asked twice.** The first `getUserMedia` is answered "denied" by the
  system dialog, but the dialog itself backgrounds the WebView (`app hidden - releasing the
  camera`), and its close re-opens the camera (`app visible - reopening`), which raises the
  permission dialog a second time. The microphone path does not do this (`already refused ... not
  asked again`).
- **P2 - Online, the stored feed stays on screen ~3 s after the server answered.** 4 of 4 timed
  runs: `<- 200 GET /api/posts` lands 0.06-0.5 s before `stored first page drawn`, yet the
  "Fil enregistre sur l'appareil, mise a jour..." status (no rights, no vote) shows for 3.0-3.6 s
  and clears **3.1-3.5 s after that answer**. Nothing in the console names what the answer waits
  on.
- **P2 against the expectation (not claimed by #1896) - back online, the stored feed is not
  refreshed by itself.** After an offline start, `[CONNECTIVITY] server reachable again` and
  `[PROMOTE] ... session is online` at 20:44:06, and 40 s later the feed still says "pas de reponse
  du serveur"; "Reessayer" replaced it (`200 GET /api/posts`, status gone).
- **P3 - Back closes the new-post composer holding a camera video with no question**, and the
  video is not in the composer when it is reopened.
- **P3 - the take reaches the post composer as `canari-video-*.bin`** (`video/x-matroska`), and its
  composer thumbnail is a flat grey tile.
- **P3 - the refusal screen says "Autorisez la camera et le micro"** in the chat camera, which never
  asks for the microphone.

**Noise met on the way (every line is a finding):**

- **Offline cold start: 70 warnings in 6 s.** Each API call logs `[API] getToken failed ... -
  proceeding without auth (TypeError: Failed to fetch)` and goes out unauthenticated; `[A]
  refresh-transport ... TypeError` per attempt; `[PENDING] page did not arrive (TypeError: Failed
  to fetch) - retrying with limit=250`, then 125, 62, 31, 15, 7, 3, 1 (eight requests halving a
  page size against a transport failure); `[DISPLAYNAME] profile fetch failed - this user renders
  as "unknown" for the next 120s` 6 times; `[MLS] revocation check unreachable - treated as NOT
  revoked`. Several still carry a raw `TypeError: Failed to fetch` where #1843 made a transport
  failure ONE type.
- **Every launch asks this account's own devices for the history of 8 bench communities**
  (`[GRAINE] asked 43319a65... (every device) ... reason no-seed-held`), before and after the PIN
  change alike.
- Logcat, Canari pids: no `FATAL`, no ANR. Chromium's camera stack: `E/cr_VideoCapture:
  CameraDevice.StateCallback onOpened` at error level, 45 `W/CameraManagerGlobal: Ignoring status
  update of camera 0`, `W/MessageQueue ... sending message to a Handler on a dead thread` at a
  recording's end; `W/cr_media ... BLUETOOTH_CONNECT permission is missing` per camera open.
- The online cold start's console carried **0** warnings or errors at launch.

## The Mi 9T readings of v1.2.8-alpha.1 (2026-10-15)

Build `1.2.8` (`versionName` from `dumpsys package`), the `v1.2.8-alpha.1` release APK installed with
`adb install -r` over the `1.2.7-alpha.3` build (accepted, no signature or downgrade refusal, account
kept), dev estate, account `fourth` ("Canari Test Delta"), bench conversations only. The phone is on
the vault path ("Rester connecte"), so no PIN gate was drawn. Evidence:
`<harness-dir>/a1-bench/r1015-a128/` (`runs.ndjson`, summaries). Dev has no push,
so reading 5 could not be taken.

| Reading | Verdict | What was seen |
| --- | --- | --- |
| 1. Start, version, unlock | **`PASS`** | Settings > A propos reads "Version de Canari 1.2.8-alpha.1" and "Vous utilisez la derniere version"; the app opened straight onto the feed on the vault path (a PIN-path unlock was not exercised) |
| 2. Communities and a salon | **`PASS`** | `community-open.mjs --community Bench126 --runs 3 --start cold --net none --cpu 1`, medians ms: attach 552, nav 1099, **tap>rail 1134** (worst 1243), tap>salons 2244, tap>target salons 2512, **salon>pane 277**, salon>msgs 1833, switch>salons 143, switch salon>pane 202, reopen>msgs 773; long tasks 728, max gap 443 |
| 3. Notification level, private conversation | **`PASS`** | The phone holds no group, only the DM with gamma (a bench account). Its "Infos de la discussion" panel shows Notifications with Tous / Mentions / Aucune; "Mentions" highlights, then "Tous" restores it. Persistence across a restart not read |
| 4. Reply swipe near the right edge (#1880) | **`PASS`** | A swipe on an own bubble from x=985 of 1080 with a 70 px vertical drift arms "Repondre a Canari Test Delta" with the bubble's text in the composer. **From x=1040 the system back gesture wins** and the conversation closes: the gesture zone is the system's, not the app's |
| 5. Group notification shows the sender | **`NOT-OBSERVED`** | No group on the phone and no push on dev |
| 6. In-app log export | **`PASS`** | "Enregistrer le journal" saves `canari-log-1.2.8-alpha.1-20261015-0130.txt` (1.8 MB, 20471 lines) to Telechargements. All **397** `[SEND] handleSendChat` lines carry `text="[N chars]"`; no quoted value outside that shape, no `eyJ` or `Bearer`. The one-word leak of the 1.2.7 reading (`text="ok"`) is not present |

**Met on the way:** a tap on the profile settings icon during the page transition hit the camera badge
and opened the photo picker; it was cancelled without choosing. Tap again once the page is drawn.

## The Mi 9T readings of v1.2.8-alpha.2 (2026-10-15)

Build `1.2.8` (`versionName`), the `v1.2.8-alpha.2` release APK (`app-universal-release.apk`, sha256
`2ac1560f...`) installed with `adb install -r` over the alpha.1 build (accepted, no signature or
downgrade refusal, account kept), dev estate, account `fourth` ("Canari Test Delta"), bench
conversations only, vault path (no PIN gate drawn). The only delta since alpha.1 is #1889: a salon
message over the socket honours the salon's notification level. Evidence:
`<harness-dir>/a1-bench/r1015-a128a2/` (`runs.ndjson`, summary, frames, `log.txt`).
Dev has no push, so what #1889 changes (a notification suppressed or kept) could not be observed.

| Reading | Verdict | What was seen |
| --- | --- | --- |
| 1. Start, version, unlock | **`PASS`** | Settings > A propos reads "Version de Canari 1.2.8-alpha.2" and "Vous utilisez la derniere version"; the app opened on the feed on the vault path (a PIN-path unlock was not exercised) |
| 2. Communities and a salon | **`PASS`** | `community-open.mjs --community Bench126 --runs 3 --start cold --net none --cpu 1`, medians ms (alpha.1 in brackets): attach 329 [552], nav 1092 [1099], **tap>rail 1072** [1134] (worst 1088), tap>salons 1899 [2244], tap>target salons 2276 [2512], **salon>pane 279** [277], salon>msgs 1834 [1833], switch>salons 174 [143], switch salon>pane 201 [202], reopen>msgs 676 [773]; api calls 65, long tasks 699, max gap 439. Same shape as alpha.1, within run-to-run noise |
| 3. Notification level of a bench salon | **`PASS` (the control), the effect `NOT-OBSERVED`** | Salon "general" of a bench community: Parametres du canal shows Notifications with Tous / Mentions / Aucune, Tous selected; "Mentions" highlights, then "Tous" restores it. No push on dev, so a message received over the socket under Mentions/Aucune was not produced |
| 4. In-app log export | **`PASS`** | `canari-log-1.2.8-alpha.2-20261015-0223.txt` (2.15 MB, 23773 lines): 0 `eyJ`, 0 `Bearer`; of 383 `handleSendChat` lines, the 192 carrying a text all read `text="[N chars]"`, the rest are "completed (message queued)"; no bench message text (`coucou`, `heldA*`, `iosA3*`, `Rendez`) found |

## The iPhone 12 readings of v1.2.8-alpha.1 (2026-10-15)

TestFlight build `1.2.8-alpha.1` (the phone had not taken alpha.2 yet: Settings > A propos itself
offers "Une version plus recente (1.2.8-alpha.2) est disponible"), account `canari-test-gamma`, dev
estate, driven over WDA (`tools/ios-device`). The app opened on the PIN gate (no vault); the bench
account's PIN was typed on the keypad with the user's authorisation of 2026-10-15, and the gate
opened onto the feed. Bench community "Bench126" only; nothing sent, no account switched.

| Reading | Verdict | What was seen |
| --- | --- | --- |
| 1. Start, version | **`PASS`** | PIN gate, then the feed; Settings > A propos reads "Version de Canari 1.2.8-alpha.1" |
| 2. Communities and a salon | **`PASS`** | The Communautes tab lists Bench126 and its "general" salon; the salon opened with its history drawn within the 3 s the tap was followed by (no stopwatch run; a feel, not a measurement) |
| 3. Notification level of a bench salon | **`PASS`** | Parametres du canal shows Notifications with Tous / Mentions / Aucune, Tous selected; Mentions selected (Tous 0, Mentions 1), then Tous restored (1, 0, 0). Effect not observed (no push on dev) |
| 4. Reply swipe (#1880) and back gesture | **`PASS`** | A rightward drag on a peer bubble ("Canari Test Delta") stages "Repondre a Canari Test Delta" and the conversation stays open; a leftward drag from x=350 of 390 on an own bubble stages "Repondre a Canari Test Gamma"; both cancelled with "Annuler la reponse". A left-edge drag (x=2 to 260) from the salon returns to the community's salon list |
| 5. In-app log export | **`NOT-OBSERVED`** | "Enregistrer le journal" opens the system "Enregistrer sous" picker (canari-log-1.2.8-alpha.1...) over an empty "Sur mon iPhone"; dismissed without saving. The file cannot be read off the TestFlight container from the workstation, so the absence of message text was not checked on iOS (the Android export of the same build is `PASS`) |

## The iPhone 12 readings of v1.2.9-alpha.1 (2026-10-15)

TestFlight build `1.2.9` (100200901), About reads "Version de Canari 1.2.9-alpha.1"; account
`canari-test-gamma`, dev estate, driven over WDA (`tools/ios-device`), timings by
`tools/phone-bench`. Evidence (screens, AX trees, syslog, `commtabs.ndjson`) is outside the repo in
the rig's `ios-bench/r1015-a129a1/`. Bench community only; nothing sent.

**Delivery.** At 19:50 the phone still ran `1.2.8-alpha.1` with auto-update ON: it never took
alpha.2. By 20:09 auto-update had silently installed the `1.2.8` STABLE (100200899, a production
build), never launched. The alpha.1 IPA reached TestFlight at ~20:09 (release run 38780575538);
TestFlight offered "Mettre a jour" to 100200901 at 20:12 and one tap installed it. "Builds
precedents" still lists nothing newer than 1.2.3 ([backlog](backlog.md)). After the update the app
was SIGNED OUT and asked camera and microphone permission again.

| Reading | Verdict | What was seen |
| --- | --- | --- |
| 1a. Dynamic Type at cold start (#1884) | **`PASS`** | PIN title 202x30 at default, 272x41 at the largest standard size (1.35x), 2x at the largest accessibility size; feed text and bubbles scale with it |
| 1b. Default size unchanged | **`PASS`** | PIN gate identical to `1.2.8-alpha.1` at default |
| 1c. Size changed while backgrounded | **`FAIL`** (P2) | 3 of 3: the "A propos" link kept its old size on return (64x22, 86x30, 128x42 stayed put); the new size applies only after a cold start |
| 1d. Layout at 2x | **findings** | P2: the PIN keypad is mostly below the fold - digits 7-0, "Saisie manuelle", "PIN oublie ?" and "Rester connecte" sit behind the sticky Deverrouiller button, and scrolling to them pushes the dots off screen (the links are already hidden at 1.35x). P3: the community rail's salon name does not scale while "Ajouter un canal" does. P3: feed titles break mid-word ("personnalisati/on") and the header wordmark is dropped. Settings rows and the glass title pill truncate with an ellipsis; the composer and tab bar (icons) are fine. Reel text overlay `NOT-READ` |
| 2. In-app camera (#1859) | **`PASS`** + P2 | Chat "+" > "Ouvrir la camera" and the post composer's "Ouvrir la camera" both open the in-app dialog ("Photo (toucher) ou video (maintenir)", "Changer de camera"). P2: in the chat, the conversation's glass chrome (back, title pill, menu, "+") paints ON TOP of the viewfinder; the post composer's camera is clean. The post camera asks for the microphone at open, the chat camera does not |
| 3. Feed local-first (#1896) | **`PASS`** + P2 | Offline in session, the feed draws under the offline banner (not separable from memory). A cold unlock right after Wi-Fi returned showed "Fil enregistre sur l'appareil : pas de reponse du serveur." with "Reessayer" - the device copy - and did NOT refresh by itself in 20 s (P2); "Reessayer" replaced it. A normal online cold unlock shows no status line. A "Voir plus" tap made right after unlock still held 4 s later. Cold start offline stops at the PIN gate ("Impossible de contacter le serveur", by design) |
| 4. Communities tab (#1897) | **`PASS`** (taps); timings `NOT-MEASURED` | Taps switch tabs. `bench.timed_action`: warm first 800-858 ms, settled 1237-1299 ms; cold first mount 804 / 1183 ms - no first-mount penalty. But the harness dispatch median is 1031 ms (522 ms on 2026-09-30), above the app's latency, so the absolutes are not a measurement |
| 5. PIN change, then relaunch (#1898) | **`FAIL`** (P1) | Settings > Securite & appareils > the key button (no AX label, P3) > "Changer mon PIN". The submit said "Le changement de PIN n'a pas abouti. Reessayez dans un instant." while the dev access log shows `POST /api/mls/security/pin-change` **201**; the retry got 403 ("Le PIN actuel est incorrect."). The server rotated, the local re-seal did not. On relaunch the old PIN is refused, the new one passes the server check and lands on "Vos messages enregistres sur cet appareil n'ont pas pu etre ouverts"; "Recuperer mes messages" (old -> new) fails twice with "La recuperation du PIN n'a pas abouti" after `pin-salt` and `pin-check` 201. The device's messages stay locked. No app-level error in the syslog or core-service log. P2 in both dialogs: with the keyboard up the sticky submit button covers the next field, so tapping it submits the form ("Veuillez remplir tous les champs") and the focused field is hidden while typing |
| 6. | skipped | by the brief |
| 7. Noise | **findings** | Native syslog only (the JS log cannot be read off a TestFlight build): "keyboard accessory bar NOT removed: no WKContent view" (7x per session), "remote notification hook: selector absent on AppDelegate", "push diagnostic: no-apns-token", "APNs token not here yet", UIKit "may only be set for UIKBDynamicRenderFactory" on keyboard show. P3: native lines in French ("FCM token synchronise", "secret plus recent adopte depuis pending_push_secret.txt", "FCM delegate installe") |

**State left behind.** `canari-test-gamma`'s dev PIN is now a scratch PIN held by the rig operator,
not the one in `test-accounts.json`, and the iPhone's local store is sealed under the old PIN and
cannot be opened. Either the account PIN goes back or the harness file follows.



## The iPhone 12 readings of v1.2.9-alpha.2 (2026-10-16)

TestFlight build `1.2.9` (100200902), About reads "Version de Canari 1.2.9-alpha.2"; account
`canari-test-gamma`, dev estate, driven over WDA (`tools/ios-device`). Evidence (screens, AX trees,
syslog, two in-app log exports) is outside the repo in the rig's `ios-bench/r1015-a129a2/`. Bench
community only; nothing sent. The phone has no device passcode.

**Delivery.** Release run 38809585188 finished at ~23:45. At 23:51 TestFlight offered
"Mettre a jour" to 100200902; auto-update had not taken it yet, and one tap installed it. This time
the app was NOT signed out.

**The in-app log CAN be read off a TestFlight build.** Settings > A propos > "Enregistrer le journal"
saves it to "Sur mon iPhone". The Files app's Quick Look shows it, and WDA's element text on its
`TextView` returns the whole file (172 KB). So the line in the alpha.1 reading saying "the JS log
cannot be read off a TestFlight build" was wrong: the log existed. The second export holds every
session since 2026-10-14, the alpha.1 ones included.

| Reading | Verdict | What was seen |
| --- | --- | --- |
| 1a. PIN recovery from the alpha.1 left state (#1923) | **`PASS`** + P2 | The server PIN gives "Vos messages ... n'ont pas pu etre ouverts". "Recuperer mes messages" (old PIN -> server PIN) logs `[PIN_RECOVER] Complete - messages preserved` and lands on the feed; the salon's messages read. P2: a banner "Certaines conversations n'ont pas pu etre restaurees" appears, with `[INIT] Partial restore: 0/1 conversation(s) hold their MLS group (missing 3122333c)`. The external join for that same group then fails with `group 3122333c already present locally`, which contradicts "missing". The next cold start applied the queued commit and logged past-epoch frames from the peer as `LOST` |
| 1b. PIN change, relaunch, change back | **`PASS`** | Scratch -> new PIN: the dialog closes with no error. The syslog shows LocalAuthentication `-5 "Passcode not set"` and then only `SecItemAdd` with no failure. The relaunch unlocks on the new PIN and the salon reads. New -> the `test-accounts.json` PIN: same result. The alpha.1 P2 is fixed: the focused confirm field sits above the submit button with the keyboard up. The alpha.1 P3 is fixed: the key button is now labelled "Changer" |
| 2a. Text size changed while backgrounded (#1926) | **`PASS`** 4 of 4 | The new size applies on return, with no cold start. "A propos" goes 64x22 -> 86x30 (largest standard) -> 128x42 (largest accessibility), and back to 53 pt filter buttons at default. The PIN gate title is 272x41 on return at the largest standard size. The syslog logs `Dynamic Type body published to the page: 17.0 / 23.0 / 53.0 pt` at each return |
| 2b. Layout at the largest sizes | **`PASS`** + P2 | The rail salon name now scales ("general" 281x64). Headings hyphenate ("person-/nalisation"), at default too. The CanaReels filter row holds at 390 wide; at the largest size "Tous les posts" wraps onto two lines. Still P2 (from alpha.1): at the largest standard size "Saisie manuelle" and "PIN oublie ?" sit behind the sticky Deverrouiller button, and at the largest accessibility size the keypad's rows 7-0 do too. Still P3: the header wordmark is dropped at the largest size |
| 3a. Chat camera under the glass chrome (#1926) | **`PASS`** | "+" > "Ouvrir la camera" shows only the camera's own close and flip buttons over the viewfinder. The native back, title pill and menu are hidden |
| 3b. Back with the camera and the "+" menu (#1925) | **`FAIL`** (P2) | Over the photo review, the left-edge swipe does nothing (2 of 2), although [reels-in-chat](frontend/modules/reels-in-chat.md) says it discards a review and closes the camera. The review's X asks "Abandonner cette capture ?"; "La garder" returns to the review and "Ajouter" stages the photo. After that, ONE Back leaves the conversation, so no ghost entry is left. With the "+" menu open, ONE Back closes the menu AND leaves the conversation (2 of 2), where it should close only the menu. The staged photos survive leaving the conversation as a draft |
| 4a. Feed offline then online (#1922) | **`PASS`** | Offline in a session, the feed draws under the "Hors connexion." banner. Back online, `GET /api/posts` leaves 0.3 s after `browser reports online` and the banner goes. Sampled for 80 s: no offline/online flap, and no presence or `TransportFailure` line after the reconnect |
| 4b. CanaReels filter (#1920) | **`PASS`** | Taps switch to "Pas encore de CanaReels" with "Ouvrir la camera", then back |
| 5a. Native noise at cold start (#1926) | **`PASS`** + P3 | 5 launches: "keyboard accessory bar removed" once each, 0 "NOT removed"; the APNs line once; app lines in English. P3: Firebase's own `<ERROR> Error while reading embedded mobileprovision` once per cold start (no profile in a TestFlight build). "remote notification hook NOT installed" stays as a known item ([backlog](backlog.md)) |
| 5b. Offline cold start (#1921) | **`PASS`** + P3 | Airplane mode: 22 in-app lines up to the PIN gate, 3 `W`: `refresh✗transport` once, and `[LAYOUT] Profile check did not answer` TWICE, an identical pair (P3). The unlock says "Impossible de contacter le serveur" (by design) and `refresh not sent` is held. No storm. P3: the gate keeps the digits of the failed offline attempt and appends the next ones (12 dots), which costs one "PIN incorrect" |
| 5c. In-app log | **findings** (P2, P3) | P2: `stored: failed (Error: log write failed)` and `E [APPLOG] the in-app log is no longer written to disk` at 00:07:07, the return from Settings at the largest size. The 00:00 and 00:06 sessions are missing from a later export, which reads `stored: ok`. P3: offline in a session, the WS reconnect loop logs `E [WS] Gateway connection failed` on every attempt (6 in 61 s) while the browser reports offline |

**State left behind.** `canari-test-gamma`'s dev PIN matches `test-accounts.json` again. The
iPhone's local store opens under it. Text size is at the default, airplane mode is off and the
composer draft is empty. Two exported logs remain in "Sur mon iPhone".

## The iPhone 12 readings of v1.2.9-alpha.3 (2026-10-16)

TestFlight build `1.2.9` (100200903), About reads "Version de Canari 1.2.9-alpha.3"; account
`canari-test-gamma`, dev estate, driven over WDA (`tools/ios-device`). Evidence (screens, AX trees,
the app's own syslog lines, in-app log exports) is outside the repo in the rig's
`ios-bench/r1016-a129a3/`, with `marks.txt` timing every step. Bench community and the bench DM
only; nothing sent, nothing paid.

**Delivery.** Release run 38825712616 finished at ~02:05. TestFlight offered "Mettre a jour" to
100200903 at 02:17; one tap installed it, and the app was NOT signed out.

| Reading | Verdict | What was seen |
| --- | --- | --- |
| 1a. Edge swipe with the "+" menu open (#1936) | **`FAIL`** (P2) | 3 of 3 (DM twice, salon once): ONE left-edge swipe closes the menu AND leaves the conversation, as on alpha.2. A plain tap at the left edge with the menu open closes only the menu. The cause is not read: the `[historyOverlay]` lines are debug, and the in-app log does not record them. First thing to check: whether the menu is already closed (and off the stack) by the gesture's start, so that the swipe's end finds the conversation on top |
| 1b. Edge swipe with nothing open | **`PASS`** | It leaves the conversation (DM and salon), and the salon row "general" is NOT left highlighted |
| 1c. Edge swipe over the camera's photo review (#1936) | **`PASS`** | The swipe asks "Abandonner cette capture ?". "La garder" keeps the review, and the next swipe asks again. "Abandonner" leaves the live camera open; the next swipe closes the camera and stays in the conversation |
| 1d. Paint stroke from the left edge in the editor | **`PASS`** | A stroke dragged from x=2 draws a line from the edge; the editor stays and nothing asks to leave. A sticker dragged from the edge `NOT-READ` |
| 1e. Edge swipe while filming | `NOT-READ` | WDA did not hold the shutter as a video take: a 3.5 s press and a two-finger press-and-swipe both produced a PHOTO review |
| 1f. Legal document page back | `NOT-READ` | Signed in, no screen links to `/legal/*` (only the login page does); not worth a sign-out |
| 2a. PIN change, relaunch, change back (#1935) | **`PASS`** | Account -> scratch: "PIN modifie" in under 1 s. Relaunch, scratch PIN; scratch -> the `test-accounts.json` PIN; relaunch, unlock: the feed, the salon and the DM read, and no "Certaines conversations n'ont pas pu etre restaurees" banner. The log of the second unlock after it (the first one's lines went with 3e) has no `Partial restore` and no `already present locally`, and reads `[MLS][Tauri] group caches rebuilt from the native manager - 2 group(s)`. The interrupted state was NOT reproduced: a kill 300 ms and 650 ms after the submit left the server PIN unchanged both times |
| 2b. Refused PIN empties the field (#1935) | **`PASS`** | Online: a wrong PIN gives "PIN incorrect ..." and the dots go back to the empty placeholder. Offline: "Impossible de contacter le serveur", and the field is empty too |
| 2c. Largest accessibility size on the PIN gate (#1935) | **`PASS`** + P3 | Rows 7-0, "Saisie manuelle" and "PIN oublie ?" scroll into view on a drag up, and the keypad unlocks from there. P3: the "Rester connecte sur cet appareil" row stays half under the sticky Deverrouiller button at the end of the scroll |
| 3a. Text size changed while backgrounded | **`PASS`** | "A propos" 64x22 -> 86x30 (largest standard) -> 126x42 (largest accessibility), no cold start; back to 53 pt filter buttons at the default |
| 3b. Feed offline then online | **`PASS`** | The feed tab opened offline shows "Impossible de charger les posts" under "Hors connexion."; back online the posts draw by themselves within 8 s and the banner goes |
| 3c. Native noise | **`PASS`** | 8 launches: "keyboard accessory bar removed" 8, "NOT removed" 0; Firebase's mobileprovision `<ERROR>` once per launch and "remote notification hook NOT installed", both known from alpha.2 |
| 3d. Offline cold start | **`PASS`** | Airplane mode, cold start (twice): the gate draws and stays; the offline unlock says "Impossible de contacter le serveur" (by design). Back online, the unlock goes through |
| 3e. In-app log | **findings** (P2) | The alpha.2 P2 again, with the same trigger: `E [APPLOG] the in-app log is no longer written to disk (failed): Error: log write failed` at 03:21:39, leaving for Settings at the largest accessibility size. The export after it reads `stored: failed` and holds ONLY the session begun at 03:20 (19 KB, against 191 KB an hour earlier). The next export, after a cold start, is back to `stored: ok` and 216 KB |
| 4. Paid form on dev (#1916, #1930) | **`PASS`** (observation) | `fr.emse.canari://form/<id>` opens "Cotisation BDE 2026" with no crash (this account's answers hit "Combinaison indisponible"). `fr.emse.canari://payment/success?submission_id=<unknown>` shows "Paiement introuvable" with "Retour aux formulaires", right for an id that does not exist; the waiting state needs a real pending submission and was not read. P3: that page's title is still "Paiement reussi - Canari" over "Paiement introuvable" |

**The rig.** `phone-ios.mjs`'s `setAirplaneMode` failed on iOS 27 in French: Control Center's
toggles answer "Oui" / "Non", and a status-bar image labelled "Wi-Fi" sits above the Wi-Fi toggle.
Both are fixed in this PR (`switchState` reads "Oui" / "Non"; `setSwitch` takes the labelled element
that answers as a switch). Airplane on and off then read back right four times.

**State left behind.** `canari-test-gamma`'s dev PIN matches `test-accounts.json`, and the
iPhone's local store opens under it. Text size is at the default, airplane mode is off and both
composer drafts are empty. Five exported logs remain in "Sur mon iPhone".

## The iPhone 12 readings of v1.2.9-alpha.4 (2026-10-16)

TestFlight build `1.2.9 (100200904)`, Settings > A propos reads "Version de Canari 1.2.9-alpha.4",
account `canari-test-gamma`, dev estate, driven over WDA (`tools/ios-device`). Evidence (screenshots,
the three in-app log exports read in Files Quick Look, a syslog capture) is under
`canari-harness/ios-bench/r1017-a129a4/` on the bench workstation. Nothing sent, nothing paid.

**Delivery.** Release run 38888170609 finished green at about 12:53; at 13:02 TestFlight offered the
build with "Mettre a jour" (auto-update had not taken it yet), installed by 13:04. The app came back
on the PIN gate, not signed out.

**Instrument note.** `ios.mjs swipe` is an XCUI press-and-drag: it draws no paint stroke and its
second swipe on the photo review did nothing 3 of 3. A W3C `gesture` touch sequence (x=2 to 260)
does both, so 1c and 1d are read with it; 1a was read with both and they agree.

| Reading | Verdict | What was seen |
| --- | --- | --- |
| 1a. "+" menu open, ONE edge swipe (DM x3, salon x3) | **`FAIL` (P2)** | 12 of 12 (6 XCUI, 6 W3C): the swipe closes the menu AND leaves the conversation. The in-app log has one `I [historyOverlay] gesture Back closes overlay N, 0 left open` per swipe (13:07:20.438, 13:07:51.685, 13:08:07.118, ...) and 0 `gesture Back spent`: the menu was on top at the commit and was closed by the overlay owner, and a SECOND Back path then left the conversation, one the in-app log does not name (candidates, not proven: the WKWebView back-forward swipe, or the conversation's own swipe owner also committing) |
| 1b. Edge swipe with nothing open | **`PASS`** | Leaves the conversation, in the DM and in the salon |
| 1c. Photo review "Abandonner ?" | **`PASS`** | The swipe asks "Abandonner cette capture ?"; "La garder" keeps the review and a second swipe asks again; the review's X asks, "Abandonner" returns to the live camera, the next swipe closes the camera and stays in the conversation |
| 1d. Paint stroke from the left edge | **`PASS`** | A stroke from x=2 draws and the editor stays; its back arrow asks "Abandonner vos modifications et revenir a la capture ?" |
| 2. In-app log across Settings at the largest text size | **`PASS`** | Export at 13:32 after the trip: header `# stored: ok`, 2974 lines, 241 KB, sessions back to 2026-10-14 kept. The 14:21 export (262 KB) carries `13:32:15.602 I [APPLOG] a write was cut short as the app left the screen (Error: log write failed) - 23 lines kept, for the return`, then a clean resume |
| 3. PIN gate at the largest text size | **`PASS`** | At the end of the scroll "Rester connecte sur cet appareil" is fully visible above Deverrouiller, with "Saisie manuelle" and "PIN oublie ?"; rows 7-0 reachable and the unlock from the scrolled keypad works. P3: before scrolling, Deverrouiller (y 665-742 pt) overlaps rows 7-9 (654-732) |
| 4. `payment/success?submission_id=<unknown>` | **`PASS`** | Deep link with a nil UUID: WebView title "Paiement introuvable - Canari", heading "Paiement introuvable", link "Retour aux formulaires". P3: the hidden route announcer still reads "Verification du paiement... - Canari" |
| 5a. Feed header | **`PASS`** | One row: Associations / Suivis / Tout and the "Ouvrir les CanaReels" icon at the right, 44x44 pt; at the largest size the tabs scroll and the icon stays |
| 5b. Reel viewer | **`PASS`** | The clap opens the full-screen viewer at the newest reel; avatar and name bottom-left over a scrim; the backdrop is PAINTED on the first reel (mean RGB top 85,83,75, bottom 55,57,50, not black); it loops, a 16-frame burst shows no still longer than 0.6 s; the left-edge swipe returns to the feed |
| 5c. Swipe to the next reel | **`FAIL` (P2)** | The swipe moves, but reels 2 and 3 (another author's, 9 and 8 Oct.) show only the yellow play button on a dark gradient: no "Lecteur video" in the AX tree, a tap on play does nothing; reel 1 plays again when swiped back. Cause NOT read: a Quick Look search of the export found no line at the minute of the swipe. P3: the author link's AX rect is 16,-196 242x869 |
| 5d. "Voir plus", caption scroll, tap folds | **`NOT-OBSERVABLE`** | No reel on dev has a caption past 2 lines, and posting one is outside this reading |
| 6a. PIN change + relaunch | **`PASS`** | "PIN modifie..."; after terminate + launch the old PIN is refused and the new one opens the feed with no restore banner, the DM reads; changed back. P2 still present: with the keyboard up the confirm field sits behind the sticky "Changer mon PIN" button and is reachable only after blurring |
| 6b. Refused PIN empties the field | **`PASS`** | "PIN incorrect : ce PIN ne correspond pas..." and the field returns to its placeholder |
| 6c. Text size on return | **`PASS`** | Back from Settings at the largest size, the "A propos" link measures 126x42 pt, no cold start |
| 6d. Offline cold start | **`PASS`** | Airplane mode, terminate + launch: a calm PIN gate; an unlock reads "Impossible de contacter le serveur. Verifiez votre connexion puis reessayez.", the field empties, stable after 20 s; airplane off, the unlock reaches the feed |

**State left behind.** Canari unlocked in front on dev (Settings > A propos), default text size,
airplane mode off, the bench account's PIN as in the harness file, composer drafts empty. Three log
exports remain in Files > Sur mon iPhone.

## The bench readings of v1.2.7-alpha.2 (2026-10-14)

**Mi 9T**: build `1.2.7 (100200702)`, the release's `app-universal-release.apk` (sha256
`99379a80...`), installed with `adb install -r` over alpha.1: same signature, the enrolment of
`fourth` ("Canari Test Delta") survived, PIN gate first. Numbers from CDP on the inspectable WebView,
logcat and the in-app log export. **iPhone 12**: TestFlight `1.2.7 (100200702)`, account
`canari-test-gamma`, driven over WDA; the native lines read from the device syslog
(`pymobiledevice3 syslog live -pn Canari`). Dev still sends no push. Evidence:
`<harness-dir>/a1-bench/r1014-a127a2/` (frames, `cons-*.ndjson`, `logcat-*.txt`,
`inapp-log.txt`) and `.../ios-bench/r1014-a127a2/` (frames, `syslog-canari.txt`).

**How the iPhone got the build.** TestFlight's app page offered `1.2.7 (100200702)` with "Mettre a
jour"; the phone was on `1.2.3 (100200305)` with "Mises a jour automatiques" OFF (turned off by the
2026-10-11 install from "Builds precedents"). One tap updated it, the enrolment survived (PIN gate),
and automatic updates are now ON. **Watch it**: with them on, a later STABLE build (which talks to
production) replaces the bench pre-release by itself, as on 2026-10-11.

| Reading | Phone | Verdict | What was seen |
| --- | --- | --- | --- |
| #1843 offline banner text | Mi 9T, iPhone | **`PASS`** | "Hors connexion. Vous pouvez lire vos conversations. Les messages de vos conversations privees partiront des le retour du reseau ; dans un salon, attendez la connexion pour ecrire." on both (`14-off-cold.png`, iPhone `26-offbanner.png`) |
| #1843 offline cold start: the community list | Mi 9T | **`FAIL` against the expectation, not a regression** | On the vault path (a PIN-only cold start cannot unlock offline, by design, check N), the rail is EMPTY offline: "Selectionner ou creer une communaute" (`15-off-comm.png`). Nothing in alpha.2 claims a cached rail; recorded so nobody reads the banner as a promise of one |
| #1843 a salon send whose community is not loaded | Mi 9T | **`PASS`** | Deep link to the salon offline, send: "En attente..." and `[SEND] channel send 8a11887e... HELD: salon a4b30b40 is not loaded on this device yet`, no error (`20-off-sent-15s.png`) |
| #1843 network back | Mi 9T | **`PASS`** | `[WORKSPACE-LOAD] reconnect - listing the communities again (the last one gave up)`, a first attempt that raced the radio (`attempt 1/4 failed: TransportFailureError`, retryable), `[CONNECTIVITY] server reachable again`, `reconnect during a reconnect's own listing - nothing owed`, `released: its salon is loaded`, `communities/channels loaded (attempt 2)`: the rail and the held send settle **3.3 s** after the online event; the message left ONCE (`settled as d9513a22`; gamma's iPhone shows it once). **No** `non-retryable`, **no** `[WORKSPACE-LOAD]` line in the 75 s after |
| #1843 failure lines in the exported log | Mi 9T | **`PASS`** | `TransportFailureError: request got no answer: error sending request for url (https://dev.canari-emse.fr/api/presence?[query]` - the query string is redacted |
| #1842 orphan WebView on a navigation-mode switch | Mi 9T | **`PASS`, one P3** | Six switches (`cmd overlay enable-exclusive` threebutton/gestural): CDP lists **ONE** page, attached, after each. A salon text refused offline before the first switch ("Non confirme") came back: `[SEND] unanswered salon message 05b01dbd... of a past session restored to the composer` (`31-switch1.png`). **P3**: the composer is not kept across a relaunch, so that restored text (and any typed draft, `sheet-38-39.png`) is LOST at the next relaunch |
| #1842 kill/relaunch, background x3, notification intent warm and killed | Mi 9T | **`PASS`** | One page each time, the salon opens from the intent. Logcat: no `FATAL`, no ANR, no destroyed-WebView warning. Four `[TAURI] Couldn't find callback id 1269519213` warnings (the SAME id) after the relaunches: a Rust callback of the first page still fires into the new one (P3 noise) |
| #1839 redaction of the exported log | Mi 9T | **`FAIL`, P2** | The alpha.2 lines are clean: `contact="[17 chars]" text="[9 chars]"`, 0 one-word text, 0 name. **But the export still carries the alpha.1 lines** of the ring, written before the upgrade with the old redaction: 10 lines with `text="coucou"`, `text="ok"`, `text="refuse1-a127"`. Redaction runs at WRITE (`appLog.ts`), never at export, so an upgraded device keeps exporting what the older build let through until the ring rolls over |
| #1835 blind salon banner offers no "Lu par" | Mi 9T | **NOT READ** | Dev sends no push, so no salon banner can be produced |
| #1841 a join is acknowledged after its checkpoint | Mi 9T | **`PASS`** | Fresh state (`pm clear`), sign-in, PIN: each of the 3 `externalJoin succeeded` lines comes right after an `Encrypted state checkpoint persisted` |
| #1844 the empty store opens with its digest; checkpoints per rejoined group | Mi 9T + iPhone | **`PASS`** | No member was online at the rejoin (`no member online for 3122333c - will ask when one returns`). Unlocking gamma's iPhone woke it: `[HISTORY_RECONCILE] a peer came back online`, then `[HISTORY_DIGEST] Sent for 3122333c - ids mode, 0 id(s)` as the FIRST leg (no state key), and 466 messages back in three bundles. **Checkpoints (native `manager lock held` lines): 9 for the 3 joins (3.0 per group), then 3 for the one exchange (1 + 2 drains)**; 15 in the 11 min after the sign-in, against 247 in 432 s on alpha.1. Lock held 0 ms 13 times of 15 |
| Salon tap, community rail, long-press menu | Mi 9T | **`PASS` in part** | A salon tap opens it; the rail fills. "Marquer tout comme lu" and the typing bubble were not read (no peer driving the salon) |
| Sign out, then sign in again, in the same process | Mi 9T | **`FAIL`, P1 candidate (2 of 2)** | Below |
| Nothing fatal | Mi 9T | **`PASS`** | Four logcat captures: no `FATAL`, no ANR, no crash |
| #1836 cold-start link | iPhone | **`PASS`** | App terminated, `fr.emse.canari://chat/channel_a4b30b40...`: syslog `[CanariDeepLink] scene connected with 1 launch url(s) and 0 web activit(ies)`, PIN, then the salon "general" (`t11.png`). Same for `fr.emse.canari://open?url=https://canari.emse.fr/notifications` cold (`t13.png`) and warm (`t12.png`) |
| "Ouvrir dans l'application" from Safari, app killed | iPhone | **`PASS`** | `canari.emse.fr/login` shows the link, Safari asks "Ouvrir dans << Canari >> ?", the line above is logged, and after the PIN the app is on `/chat` (`t16.png`) |
| Sanity: open, send, no crash | iPhone | **`PASS`** | `iosA2send` in the DM: check mark, decrypted on the Mi 9T |
| Redaction on iOS | iPhone | **NOT READ** | The exported file cannot be pulled off the TestFlight app's container; the redaction is the same JS module as Android |

**The P1 candidate: a sign-out then a sign-in in the same process never unlocks.** On the vault path
("Rester connecte" ticked earlier), Tableau de bord > Deconnexion, then "Connexion externe
(service-account)": the OIDC callback completes (`handleOidcCallback resolved`, `goto -> /posts`)
but NO PIN gate and NO vault restore follow; Communautes and Discussions sit on "Connexion en
cours..." for 4 min (`52-longpress.png`, `56-signin2-60s.png`), no avatar in the header. Twice, same
sequence (`cons-signin.ndjson`, `cons-signin2.ndjson`). In both, the resume of the app coming back
from the browser races the callback: `[A] refresh-latched (cookie already proven dead)` then
`[AUTH] Session expired - redirecting to /login.` and `[A] session->F`, 1-2 s BEFORE the callback's
`got access_token`. A kill and relaunch then opens with NO PIN: `[PIN] Device key restored from
PinVault - auto-login`, so **the "Rester connecte" vault survives the sign-out** (P2 on its own: a
signed-out device reopens without its PIN). A fresh state (`pm clear`) signs in correctly to the PIN
gate. Whether the PIN path (no vault) shows the same hang was not read.

**Also met:** on the Mi 9T, while offline, `Failed to fetch presence` is logged at ERROR level every
10 s and `[API] getToken failed ... proceeding without auth` at WARN for every request (24 times
for the workspace listing alone), and `[PENDING] page did not arrive ... retrying with limit=N`
halves the page from 250 to 1 on a transport failure: ~300 warning lines for 4 offline minutes (P3,
noise). On the iPhone, the feed read "Impossible de charger les posts" after an unlock just after the
network came back and did not retry by itself until "Reessayer" (P3). The tab bar keeps the last
tab highlighted on `/notifications` (P3, cosmetic). The Mi 9T is LEFT on a fresh device of `fourth`
(PIN path, "Rester connecte" unticked).

## The bench readings of v1.2.7-alpha.3 (2026-10-14)

**Mi 9T**: build `1.2.7 (100200703)`, the release's `app-universal-release.apk` (sha256
`96903cde...`), installed with `adb install -r` over alpha.2: same signature, the enrolment of
`fourth` survived, PIN gate first. **iPhone 12**: TestFlight offered `1.2.7 (100200703)` with
"Mettre a jour" although automatic updates were ON (the build was ~30 min old); one tap updated it
and the enrolment of `canari-test-gamma` survived (PIN gate). Evidence:
`<harness-dir>/a1-bench/r1014-a127a3/` (`export1-3.txt`, `export-*.json`,
`ring-*.txt`, `cons-offline.ndjson`, `logcat-main.txt`, frames) and `.../ios-bench/r1014-a127a3/`
(frames, `syslog-canari.txt`).

**How the old lines were produced.** The alpha.2 reading ended on a `pm clear`, so the ring held no
line from alpha.1 any more (411 lines from 12:18, every value already `[N chars]`). The 10 leaking
lines of the alpha.2 export (`inapp-log.txt`: `text="coucou"`, `"ok"`, `"refuse1-a127"`, ...) plus one
`contact="alice" text="coucou"` line were written VERBATIM into `CanariDBLog` as one chunk, over CDP,
while alpha.2 still ran (`inject.mjs`, `old-lines.txt`) - the bytes an older build stores, placed by
hand. alpha.3 was installed over that.

| Reading | Phone | Verdict | What was seen |
| --- | --- | --- | --- |
| #1861 the old lines are redacted at export | Mi 9T | **`PASS`** | The 11 lines come out `contact="[17 chars]" text="[6 chars]"` (`[5 chars]` for `alice`); 0 hit for any known string, 0 `text=`/`contact=` value that is not `[N chars]`, in all three exports. Header `555 lines - 24 values redacted` (22 at read + 2 at write) |
| #1861 the `[APPLOG] ... redacted at read` line appears once | Mi 9T | **`FAIL` against the expectation, P3** | `[APPLOG] 22 values redacted at read, in 11 lines an older build stored` - the count is exact - but it is logged AGAIN, identical, at the second export and the third, and each header counts the 22 again (`25`, then `38`). By design of #1861 (stored records are not rewritten; `ring-end.txt` still holds `coucou` 3 times), so every export of an upgraded device repeats the line until the ring rolls over |
| #1861 the export does not freeze the UI | Mi 9T | **`PASS`, on a small ring** | Tap to the save dialog 482 / 444 / 383 ms; longest frame gap 34 / 28 / 30 ms; no long task; no ANR. The ring was 555-664 lines, not a full ~5000: the yield-by-count path was barely exercised |
| #1861 fresh lines with a double quote | Mi 9T | **`PASS`** | `quote "zorglub" a3` and `trail\ back" end` sent in the DM: `text="[20 chars]"` and `text="[18 chars]"` (the JSON-quoted lengths), nothing of either text in the export or the raw ring |
| App opens on the PIN path | Mi 9T, iPhone | **`PASS`** | PIN gate, then `/posts` (`01-unlocked.png`, iPhone `05-unlocked.png`) |
| DM both ways | Mi 9T + iPhone | **`PASS`** | `a3-plain` and the two quoted texts arrive on the iPhone verbatim; `iosA3send` arrives on the Mi 9T |
| Salon both ways | Mi 9T + iPhone | **`PASS`** | `iosA3salon` arrives on the Mi 9T; `a3salon-mi9t` arrives on the iPhone ("Message lu par Canari T...") |
| Offline cold start: banner, held salon send, network back | Mi 9T | **`PASS`** | PIN path offline: "Impossible de contacter le serveur" (no unlock, by design); vault path ("Rester connecte" ticked online first): the banner on cold start; salon deep link, send: `HELD: salon a4b30b40 is not loaded on this device yet`, "En attente..."; network back: `reconnect - listing the communities again`, `server reachable again`, `released: its salon is loaded`, `settled as 55eabc2d` **4.6 s** after the online event; the iPhone shows `heldA3one` ONCE. **No** `[WORKSPACE-LOAD]` line in the 60 s after |
| Orphan WebView after two navigation-mode switches | Mi 9T | **`PASS`** | threebutton then gestural: same pid, CDP lists ONE page, attached, after each |
| Nothing fatal | Mi 9T, iPhone | **`PASS`** | Logcat: no ANR; the two `FATAL EXCEPTION` lines are `uiautomator` (uid 2000, `UiAutomationService already registered`), not the app. iPhone syslog: no crash line, no crash report |
| #1836 cold-start link | iPhone | **`PASS`** | Terminated, `fr.emse.canari://chat/channel_a4b30b40-...`: `[CanariDeepLink] scene connected with 1 launch url(s)`, PIN, the salon "general" (`14-cold-salon.png`). The DM link lands in the DM (`12-cold-dm.png`). A link to a salon gamma is not in (Bench127) lands on the community list |
| Checkpoints per rejoined group | Mi 9T | **NOT READ** | Needs a `pm clear` and a sign-in; not taken |
| Redaction on iOS | iPhone | **NOT READ** | The exported file cannot be pulled off the TestFlight app's container |

**Noise (P3, unchanged from alpha.2):** ~125 warning/error console lines for two offline cold starts
in ~2 min: `[API] getToken failed ... proceeding without auth`, the `[A] refresh` transport failure,
`Failed to fetch presence` and `[WS] Gateway connection failed` at ERROR, `[PENDING] page did not
arrive`. Logcat adds 24 `AppOps: attributionTag  not declared in manifest of fr.emse.canari`. The
Mi 9T is LEFT on the vault path ("Rester connecte" ticked) - mind the sign-out P1 candidate above.

## The iPhone 12 readings of v1.2.9-alpha.5 (2026-10-17)

TestFlight build `1.2.9 (100200905)`, account `canari-test-gamma`, dev estate, driven over WDA
(`tools/ios-device`), native lines from the device syslog (`pymobiledevice3 syslog live -pn
Canari`). The PIN gate was unlocked with the bench PIN. Evidence:
`<harness-dir>/ios-bench/r1017-a129a5/` (frames, `syslog-canari.txt`). Frames
showing a face, a personal photo library or the iOS password-autofill sheet were deleted.

**How the build arrived.** Automatic updates did their job: TestFlight listed `1.2.9 (100200905)`
with "Ouvrir", so the binary was installed. **But the process still running was the alpha.4 one.**
Settings > A propos read "Version de Canari 1.2.9-alpha.4" and "Une version plus recente
(1.2.9-alpha.5) est disponible". After a `terminate` and a relaunch it read "1.2.9-alpha.5" and
"Vous utilisez la derniere version". The enrolment survived (PIN gate). So, on a bench where WDA
keeps a session open, a background update does not take effect until the next cold start. Read
the version before trusting any row.

| Reading | Verdict | What was seen |
| --- | --- | --- |
| 1a. "+" menu open, one edge swipe (#1953) | **`PASS`, 7 of 7** | DM 4 of 4, salon "general" 3 of 3. After the swipe the menu is closed, the conversation is still open ("Retour au menu" and the composer are present) and the menu entries are gone. The control is also `PASS`: with nothing open, one swipe leaves the DM for the list, and leaves the salon for the community's salon list. Each menu open logs one native `Foundation` line (the hold, `<private>` in syslog) and each dismissal logs a second one |
| 1b. The keyboard stays up when the "+" menu opens | **`FAIL`, 8 of 8** | With the composer focused and the keyboard up (`[CanariIOS] keyboard overlap=301 -> webview height 543`), opening the "+" menu drops the keyboard every time: `keyboard overlap=0 -> webview height 844` (`12-plus.png` against `11-kbd.png`). **The cause is the menu presentation, NOT the #1953 hold.** In each of the 8 rounds, UIKit logs `Override focusSystemState: (ENABLED)` for `_UIVariableGestureContextMenuInteraction` right after the touch-up. The WebView's input session ends 0.6 to 2.7 ms later (`End asserting activeInput modality`, `responder:(nil)`, `End input session`). The hold's `NSLog` comes 58 to 91 ms AFTER that, and the hold can only act from `willDisplayMenuFor`, just before that line. The `overlap=0` line sits 1 to 4 ms before the hold only because the keyboard-frame notification is posted at the end of the same presentation pass. The two rounds without a keyboard show the override and no input-session end. **Accepted as platform behaviour**, decision and reopen conditions in [mobile](frontend/mobile.md#the-conversations-native-glass-chrome) and the backlog P3 "Accepted: the native + menu drops the keyboard" |
| 1c. Photos and Camera from the "+" | **`PASS`** | "Phototheque" opens the system picker (Photos / Collections, "Acces prive aux photos"), and "Annuler" returns to the conversation. "Ouvrir la camera" opens the in-app camera ("Fermer la camera", "Changer de camera", the "Photo (toucher) ou video (maintenir)" shutter), and "Fermer la camera" returns to the conversation. The keyboard did not come back after either one, because it was already gone (1b) |
| 2. PIN change, confirm field with the keyboard up (#1952) | **`PASS`, with a limit** | Security > Changer > "Changer mon PIN". With "PIN actuel" focused, the confirm field (y 459-514 pt) is under the sticky "Changer mon PIN" button (y 435-483). Focusing "Nouveau PIN" scrolls the form, and the confirm field moves to y 361-416, clear of the button. A tap on it focuses it with the keyboard still up: WDA's active element is "Confirmer le nouveau PIN" at y 348-403, 32 pt above the button. The limit: from the FIRST field, the confirm field is not visible until the second one is focused. The keyboard is alphabetic on these fields. Nothing was submitted, and one stray letter typed into "PIN actuel" was discarded with the modal |
| 3. Payment return announcer (#1952) | **`PASS` (structure), announcement `NOT-OBSERVED`** | `fr.emse.canari://open?url=https://canari.emse.fr/forms/success` with no `submission_id` lands directly on "Paiement introuvable". The AX tree has ONE status region ("etat de l'application", 16,580 358x93) that holds the heading and its sentence, with "Retour aux formulaires" outside it. VoiceOver was not turned on, so the actual announcement was not heard |
| 4. Reel author link (#1952) | **`PASS` on the first reel, `FAIL` on the next ones** | Reel 1: ONE link "Voir le profil de Canari Test Gamma" at 16,628 176x45 pt (height at least 44), covering the avatar and name drawn in the frame, with "9 h" outside it. A tap opens Mon profil. **Reels 2 and 3: the same link reports 16,-206 161x879 pt and 16,-206 250x1723 pt**, stable across four reads 1.5 s apart, and again after swiping back. A tap at (100,400), inside that reported rectangle, does NOT navigate. So only the accessibility frame is wrong, not the hit area, and VoiceOver would outline a box taller than the screen. Reel 2 plays ("Pause"). Also seen: on a feed post the author avatar link is 20x22 / 22x22 pt next to a separate name link of 136-161x23 pt, both below 44 pt |
| 5. Feed tabs and the CanaReels entry | **`PASS`** | Associations / Suivis / Tout select one at a time (switch values 1/0/0, 0/1/0, 0/0/1). Suivis shows "Aucun post" and Tout shows the bench reel post. At the default text size all three tabs and the CanaReels button (330,211 44x44) fit in the row. The CanaReels button is exposed as `Other`, not `Button`. The 2x-text centring (`feedTabScroll.ts`) was not read: Dynamic Type was not changed |
| 6. Sign-out, then sign-in again | **`PASS`** | On the phone the desktop `Navbar` is not rendered (`hidden md:block`), so this was the phone's sign-out: tab 4 > "Deconnexion". iOS asks "<< Canari >> souhaite utiliser << miconnect.emse.fr >> pour se connecter", then "Continuer" lands on `/login` in about 5 s. "Connexion externe (service-account)" then shows the same iOS prompt and an EMPTY MiConnect form that asks for the username, so the MiConnect session did end. No terms stage was shown. With username + password, the app lands on the feed in about 6 s. Discussions lists the DM and the DM decrypts, including a video Delta sent today. No PIN was asked after the sign-in. A cold relaunch then asks for the PIN, and the bench PIN opens the feed with no "n'ont pas pu etre ouverts" |
| Nothing fatal | **`PASS`** | 366k syslog lines: 0 `crash`, `fatal`, `EXC_` or `Terminating app` |

**Not read:** the hold's own log lines (`NSLog` arrives as `<private>` in the syslog of a TestFlight
build), the in-app log (it cannot be pulled off the TestFlight container), and VoiceOver.

## The iPhone 12 readings of v1.2.9-alpha.7 (2026-10-17)

TestFlight build `1.2.9 (100200907)`, account `canari-test-gamma`, dev estate, driven over WDA
(`tools/ios-device`), native lines from the device syslog (`pymobiledevice3 syslog live -pn
Canari`), the sign-out timed from WDA's MJPEG stream (port 9100, a frame every ~100 ms). The PIN gate
was unlocked with the bench PIN. Evidence: `<harness-dir>/ios-bench/r1017-a129a7/` (frames,
`signout-mjpeg/`, `22-signout-contact.png`, `syslog-canari.txt`). Frames showing the iOS
password-autofill sheet, the keypad mid-PIN or a reel's photographed document were deleted.

**How the build arrived.** This time it had NOT been installed in the background: TestFlight listed
`1.2.9 (100200907)` with "Mettre a jour" ~6 min after the release run went green. One tap installed
it ("Ouvrir"), then a `terminate` and a relaunch. Settings > A propos read "Version de Canari
1.2.9-alpha.7" and "Vous utilisez la derniere version". The enrolment survived (PIN gate).

| Reading | Verdict | What was seen |
| --- | --- | --- |
| 1a. The dashboard hub (#1958): rows and navigation | **`PASS`, 9 of 9** | Tab 4 is "Tableau de bord". The groups, top to bottom: the identity row ("Voir mon profil"), EXPLORER (Agenda, Associations, Listes, Institutions, Boutique, Formulaires, Notifs), COMPTE (Parametres, then "Se deconnecter" in the danger tone). The account is not a manager, so no probed group appears. Each row lands on its page: Mon profil, Agenda, Associations, Listes, Institutions, Boutique, Formulaires, Notifs, Parametres. Tab 4 brings the hub back. The sign-out row (y 688-736 pt, scrolled) clears the tab bar (761). Settings > A propos is reached from Parametres |
| 1b. Sign-out busy state | **`PASS`** | MJPEG, tap at t=0: the row is drawn normally up to ~+250 ms. From ~+350 ms to ~+550 ms the "Se deconnecter" label and icon are dimmed and the header avatar is gone. `/login` is drawn by ~+1.1 s, and the iOS end-session prompt ("<< Canari >> souhaite utiliser << miconnect.emse.fr >> pour se connecter") rises over `/login` at ~+1.3 s. **The order differs from alpha.5**, where the prompt came first and `/login` ~5 s after "Continuer". "Continuer" closes the prompt with `/login` unchanged |
| 1c. Sign-out ends the MiConnect session | **`PASS`, 3 of 3** | Each time, "Connexion externe (service-account)" shows the iOS prompt and then an EMPTY MiConnect form that asks for the username |
| 2. Sign-in again: no terms or consent stage (#1990 holds #1955 out) | **`PASS`, 3 of 3** | Username, then password, then Canari's "Connexion en cours / Echange du code d'autorisation..." and the app. No page between the password and the app, and no element matching conditions / accepter / consentement in the tree, sampled every ~0.5 s for 15 s after the submit |
| 2b. The PIN after a sign-in | **`SUSPECT`, not proven** | Sign-ins 1 and 2 landed on the PIN gate. **The first PIN attempt was refused both times** with "PIN incorrect : ce PIN ne correspond pas a celui enregistre pour ce compte". The second attempt, 6 filled dots counted on the frame, opened the app. The same PIN opened the gate at a cold start before and after. Sign-in 3 landed on the feed with NO PIN gate (as in alpha.5), and the DM decrypts. **The limit:** the dots of the two refused attempts were not counted, so a digit lost by the driver is not ruled out. The app log is not readable on a TestFlight build, so the refusal's cause is unknown. Owed: a sign-in on an inspectable bench build, reading the PIN check's request and its answer |
| 3. The "+" menu, one edge swipe (#1953) | **`PASS`, 9 of 9** | DM 5 of 5 and salon "general" 4 of 4, one round in each with the keyboard up. After the swipe, the menu entries (Phototheque, Ouvrir la camera) are gone and the conversation is still open ("Retour au menu" present). The keyboard drop is accepted and not filed. Control: with no menu open, one swipe leaves the DM |
| 3b. **The DM's native chrome with the keyboard up** | **`FAIL`, 2 of 2 in the DM, 0 of 1 in the salon** | Reproduced after a cold start. With the DM composer focused (`[CanariIOS] keyboard overlap=301 -> webview height 543`), the web composer and "Envoyer" sit at y=487 pt, as check W expects. **The native "+" sits at y=186 pt, mid-thread, beside the video bubble** (186 = 487 - 301, one keyboard overlap too high). **The glass header ("Retour au menu", the title, "Plus d'actions") is gone from the screen and from the AX tree.** Both come back when the keyboard closes (`overlap=0 -> webview height 844`). In the salon "general", the same steps leave "+" at 487 and the header in place. The DM's last message is a tall video. Frames `15-kbd-clean.png` and `16-salon-kbd.png`. The chrome code is unchanged since alpha.5, so this is not new in alpha.7. Check W on `1.2.3-alpha.5` had the "+" at 487 |
| 4. Weak network, no sign-out (#1966) | **`PASS`, with a limit** | (a) Airplane mode ON before a cold start: the PIN gate stays for 30 s, past the 20 s refresh deadline, and no sign-in screen appears. Entering the PIN offline answers "Impossible de contacter le serveur. Verifiez votre connexion puis reessayez.", a transport failure, not "PIN incorrect". Airplane OFF, then the same PIN opens the feed, still signed in. (b) Airplane ON ~60 s after a cold start, with the app in front: the PIN gate stays and there is no sign-out. **The limit:** a toggle inside the cold-start refresh's own flight was not achieved. Control Center takes over 3 s through WDA, and a blind fast tap did not register (no path change in the syslog) |
| 5. Feed tabs and the CanaReels entry | **`PASS`** | Associations / Suivis / Tout select one at a time (switch values 1/0/0, 0/1/0, 0/0/1). Suivis shows "Aucun post", and Tout shows the bench posts. The CanaReels button (330,211 44x44) opens the viewer, the reel plays ("Pause"), and "Fermer les CanaReels" returns to the feed. The button is still exposed as `Other`, not `Button` |
| Observation: edge swipe on a hub row's page | **noted, not filed** | From Agenda, opened from the hub, a left-edge swipe (two gesture shapes) stays on Agenda. No back control is drawn there, and tab 4 returns to the hub. No check states what an edge swipe should do on a hub row's page |
| Nothing fatal | **`PASS`** | 1.75M syslog lines: 0 `crash`, `fatal`, `EXC_` or `Terminating app` |

**Left on the bench:** signed in as `canari-test-gamma` on `1.2.9-alpha.7`, unlocked, on the feed.
Dynamic Type and 200 % text were not read (not owed by this build).

**3b, read again from the same evidence.** The emoji keyboard opened over the already-open DM
keyboard (`overlap=388`, 13:50:58), and `11-dmkbd-menu-open.png` then shows the header and the "+"
in place. Only the rise from a CLOSED keyboard goes wrong. The analysis and the three candidate
causes are in [mobile](frontend/mobile.md#the-dm-whose-chrome-stands-one-keyboard-too-high-2026-10-17).
**Owed on the next build that carries `keyboard settled:` (one reading names the cause):**

1. Run `pymobiledevice3 syslog live -pn Canari`, grepping for `[CanariIOS] keyboard`.
2. Open the same DM (last message a tall video) and tap the composer field with the keyboard
   closed. Then run `bun tools/ios-device/ios.mjs shot` and `bun tools/ios-device/ios.mjs webview`
   (543 tall expected), and `find "Ajouter"` for the native "+" rect.
3. Copy the `keyboard settled:` line that follows `overlap=301`.
4. Control 1: the salon "general", same steps.
5. Control 2: the DM after the emoji keyboard. Switch to it, then back.
6. Close and reopen the keyboard three times in the DM. One line per rise is the measurement.

## Traps that outlived the work that found them

Kept because each one costs a full device pass to rediscover.

- **Adding `.setKeySize(256)` to `generateBiometricProtectedKeyForAlias` only affects NEW aliases.**
  It therefore splits behaviour between fresh and upgraded installs. It was held back while the
  upgrade path was still unvalidated; now that that check is retired, do it once B-E pass.
- **An empty `deviceKeyB64` is not "no context".** Both platforms separate the two; a check that
  conflates them reads a missing key as a missing login.
- **The key sits in the keystore as RAW 32 bytes and crosses the FFI as base64.** Writers decode
  before storing, readers encode after loading, on both platforms and in both migrations. Treating
  the stored bytes as text yields no key, silently.
- **An app extension has its OWN data container.** `app_data_dir` inside the NSE is not the app's,
  so a path that is right in the app process is silently wrong in the extension. The App Group is
  the only shared storage. And the NSE runs on a locked device: write with
  `...UntilFirstUserAuthentication` or not at all.
- **Android's `MlsDeviceKeyStore` uses two Base64 flavours on purpose:** `DEFAULT` for the IV/CT
  (KeystorePlugin's at-rest format) and `NO_WRAP` for the key it RETURNS, because `DEFAULT` appends
  a newline and the Rust `decode_base64_to_32_bytes` does not trim. Do not "unify" them.

## Recording the results

Record them **here**, in the table and next to the check: what passed, on which build, and **the log
lines you actually saw**. Only a FAILURE goes to `CLAUDE.md`, as a new Work Package carrying its
captured log - a failure with no log is worth almost nothing, which is exactly why WP-FWD-1 is still
open with nothing to act on.

## The revocation wipe, read off both devices by hand

Moved off [the board](cross-client-testing.md) on 2026-08-28. Four defects, none of which any row on that board asks about, plus the reading that answers the user's question. The product stories are in `CHANGELOG.md`; what is here is the MEASUREMENT.

**AND HEAL-REVOKE NOW READS THE DISK, NOT THE LOG, 2026-08-28.** The rows asserted
`[RESET] done` and `no step failed`, which is a claim about the steps that RAN. Measured on prod the
same morning, the two disagreed: a revoked device printed `nothing of this device remains` and kept
ten `mls_not_ready_since` keys, its per-user MLS database and 8.2 MB, because the SYNC_WATCHDOG - a
5 s interval the revocation path never stopped - rebuilt them 1.25 s later. **Twenty HEAL rows
asserted the log line and not one asked the disk**, so the wipe was believed for exactly as long as
it was broken. `healrevoke.mjs` now samples `localStorage.length`, the count of `CanariDB*` databases
and `navigator.storage.estimate()` seconds after the wipe, and `theWipeLeftNoDatabase` is a FAIL
condition. The localStorage count is deliberately not asserted at zero - the page writes
`PARAGLIDE_LOCALE` back as soon as it renders - while a database is, because nothing re-creates one
without an MLS client. The product defect itself is fixed and shipped in `v0.14.10`; story in
`CHANGELOG.md`, mechanism on
[auth](frontend/modules/auth.md#erasing-a-revoked-device-and-the-125-s-that-undid-it). **The four
HEAL-REVOKE rows must run on a build carrying that fix - which for A1 means a new APK, since the
Tauri app embeds the frontend and a CD deploy never reaches it.**

**AND ASKING THE PHONE THE SAME QUESTION FOUND A SECOND DEFECT BEFORE ANY ROW RAN, 2026-08-28.**
`bun footprint.mjs --device A1` answered `canariDatabases: 1`, `bytesInUse: 5939115` on a device
whose message store is SQLite - so the WebView held 5.9 MB that nothing on that platform writes and,
until that morning, nothing on that platform deleted: `wipeDeviceToFactory` had the native stores and
the WebView's as the two ARMS of one branch. The database existed because the posts mini panel named
its backend by hand instead of asking `getStorage`. Both are fixed, with a guard test on the cause;
story in `CHANGELOG.md`, mechanism on
[auth](frontend/modules/auth.md#erasing-a-revoked-device-and-the-125-s-that-undid-it).

**RUNNING THAT MEASUREMENT BY HAND, ON A BUILD CARRYING THE FIX, FOUND A THIRD DEFECT - AND NO ROW ON
THIS BOARD ASKS THE QUESTION IT ANSWERED, 2026-08-28 14:12.** A1 on a local debug `0.14.11` was
revoked from W1's own panel and STILL kept `canariDatabases: 1` / 5 939 015 bytes, while its native
half fell 42 216 492 -> 29 249 922. **The wipe crashed the app 55 ms in**: `[RESET] wiping...` at
14:12:22.218, the biometric plugin's activity at .223, `FATAL EXCEPTION: main /
ClassNotFoundException: androidx.coordinatorlayout.widget.CoordinatorLayout` at .273, `SIG: 9`. Every
step after the biometric one never ran. Fixed with five tests; story in `CHANGELOG.md`, mechanism on
[auth](frontend/modules/auth.md#erasing-a-revoked-device-and-the-125-s-that-undid-it).

**AND THE THIRD READING OF THE SAME DEVICE FOUND A FOURTH DEFECT, ON THE HALF NO ROW HAS EVER
LOOKED AT, 2026-08-28.** With the crash fixed, A1 was revoked again and its WebView came back
genuinely empty - `canariDatabases: 0`, 261 localStorage keys down to 0, which is the previous fix
working. Reading the native side with `adb` instead of the log found **twenty-eight paths of account
state still on disk**: `mls.bin`, `canari_<userId>.db` and its WAL, `graine_seeds.json` and
`channel_keys.json` (the material the background push service decrypts notifications with),
`push_context.json`, `pending_push_secret.txt`, `fcm_token.txt`, `session-meta.json`, the
`keystore_aliases` index, five `canari_*.xml` preference files and **six cached avatars of real
people**. `clear_app_data` deleted an entry only when its extension was exactly `db`, and every file
in that list was added after that filter was written. Fixed with four Rust tests; story in
`CHANGELOG.md`, mechanism on
[auth](frontend/modules/auth.md#erasing-a-revoked-device-and-the-125-s-that-undid-it), two rules in
[durable-rules](durable-rules.md#mls-state-and-keys---mls-protocol-auth).

**AND THE MEASUREMENT ANSWERS YES, ON BOTH HALVES AND ON BOTH DEVICES, 2026-08-28 16:08.** Taken by
hand on a debug **0.14.12** carrying every fix, A1 in the FOREGROUND, both devices deleted from W1's
own panel by allowlist (`deleted 2/2`, `deletableAfter 0`).

| | A1 BEFORE | A1 AFTER |
| --- | --- | --- |
| native `residue` | **28 paths** | **0** |
| native `rewritten` | `logs/Canari.log` | none |
| `identityKeys` | 3 | 0 |
| localStorage / sessionStorage / caches | 36 / 4 / 2 | 0 / 0 / 0 |
| native bytes | 27 893 083 | 19 171 657 |
| verdict | `STATE PRESENT` | **`nothing of the account remains`** |

The logcat is the mechanism, end to end in **55 ms with no crash**: `[WS RCV] device_revoked` at
16:08:10.774, `[SECURITY] This device was revoked by its owner` at .158, `[RESET] wiping` at .604,
eight `[RESET] leaving <dir> to its owner` lines, **`[RESET] native wipe removed 26 entries, 0
failed`** at .628, `[Flags] no native_flags.json - biometricConfigured is already absent` at .653 -
the flag fix declining to recreate what the sweep had deleted - and `[RESET] done` at .659.

**AND THE USER'S SECOND QUESTION IS ANSWERED BY W3, WHICH WAS OFFLINE WHEN IT WAS REVOKED.** It never
received the frame: it sat on `/chat` reading `Hors-ligne / Connexion en cours` with
`CanariDBMls_<userId>` and 8 343 362 bytes intact, which is exactly what the design says -
`isDeviceRevoked` answers `false` when it cannot reach the server, and a transport failure is not an
answer. **One reload with a network and the deferred wipe landed**: `/login`, `canariDatabases 1 -> 0`,
`identityKeys 0`, verdict `nothing of the account remains`. No run had ever shown this, and it cost
nothing to measure because a revocation had already put a device in that state.

**What this does NOT close: neither reading came from a RUNNER, so neither is in the ledger and
`rows.mjs` will not see them.** They are hand-taken, like the six SETUP rows. The HEAL-REVOKE cell is
still owed as a script, and its predicate is now written for it: `bun footprint.mjs --device <d>`
must read `residue: 0` on a phone and `identityKeys: 0` everywhere, with the offline variant driven by
a reload rather than a frame.

### 2026-10-17 follow-up: the sort row (fixed) and the stale Tauri callback (open, cause not proven)

- **Comment sort row.** At 150-200 % text the row "Afficher les N commentaires" + Récents / Anciens / Aimés did not wrap (page scroller 553 px on a 436 px screen). `PostComments.svelte` now wraps the row and the sort group (`flex-wrap`, `min-w-0`, `gap-x-2 gap-y-1`); `textZoomBoxes.test.ts` asserts it. Owed one look at 200 % on the Mi 9T.
- **`[TAURI] Couldn't find callback id N` every ~15 s after a WebView reload** (`r1017-a129a5/cons-2.ndjson`: 27 lines, ONE id, intervals 14.85-15.05 s). The warning means Rust still answers a callback registered by the previous page. The only recurring Rust-to-JS channel in the app is the `plugin-websocket` listener in `TauriMlsService.connect()` (`addListener`); a reload does not run `pauseSocket()` (only the backgrounding path does, `sessionConnection.ts`), so a socket opened by the old page could keep delivering frames to the dead id. **NOT established from source**: no 15 s server frame was found in `backend/`, and the plugin's per-connection channel was not observed. Muting the line or adding a `pagehide` disconnect without that proof would be a guess. Next step: with the warning live, `adb logcat` for the websocket plugin plus the gateway's connection count for the account (two sockets after a reload would confirm it), then release the socket at `pagehide`.
