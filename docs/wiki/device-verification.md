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

## Where the pass stands

**Android is done except H, K, L, M and R.** The full ladder was run on **v0.11.7** on 2026-07-31 (log
archived on the user's desktop) after partial runs on v0.11.5 and v0.11.6. Two defects came out of
it, both tracked as WP-NOTIF-1 and both re-checked by **check K**. **Check H was recorded PASS and
was not one**: the user reported on 2026-08-01 that a tapped notification still does not open the
conversation. That is the lesson this file exists for - a check whose verdict is "it looked right"
is not a check, so H now names the log lines that decide it.

**iOS is NOT OWED - IT IS UNRUNNABLE. There is no iPhone (the user, 2026-08-18.)** Every iOS cell
below is therefore BLOCKED, not pending, and the distinction is the point: "owed" invites someone to
plan around it being done shortly, and nothing here will be done until hardware exists. **Do not
schedule iOS checks, and do not read a blank iOS cell as an oversight.** What follows about how to
believe an iOS build stands unchanged for whenever that day comes.

Two consequences to carry deliberately rather than rediscover:

- **The iOS half of the app ships on compilation alone**, and compilation proves nothing about
  running. Every iOS-specific claim in this wiki is a claim about source, not behaviour.
- **v0.14.0's App Store publication was never verified, and `minClientVersion` is 0.14.0** - so any
  iOS user the store has not reached is locked out, with nothing here able to detect it. The user
  decided on 2026-08-18 to leave it as is. It is recorded because the state is real, not because
  something is owed.

Not one check has ever run on hardware. The iOS half of WP-SEC-1 and WP-IOS-1 has only ever been
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
| D, E | WP-VERIF-0 (PIN change, fresh install) | PASS v0.11.7 | owed |
| F | WP-VERIF-1 | PASS v0.11.7 | owed |
| G | WP-VERIF-3 | PASS v0.11.6 | owed |
| H | WP-DEEPLINK-1 residual | **RE-OPENED** (the v0.11.7 pass missed the DM half) | owed |
| I | WP-UI-1 residual | PASS v0.11.7 | owed |
| J | WP-VERIF-4 | PASS v0.11.7 | owed |
| K | WP-NOTIF-1 | owed | owed |
| L | WP-DEV-PANEL-1 | owed | owed |
| M | WP-POST-DOC-2 | **PASS** on A1 0.13.0, 2026-08-06 (chat half) | `docs/wiki/cross-client-testing.md` |
| N | Offline unlock + promotion | owed | owed |
| O | WP-STORE-1 (install source + version gate) | owed | n/a |
| P | Cookie durability across a kill (the iOS half of WP-ANDROID-SESS-1) | n/a (fixed + verified) | owed |
| R | The shrunk release APK still having what it needs | owed | n/a |

For the iOS pass, install the `ios-release` artifact of the run above rather than waiting for
TestFlight: a dispatch does not upload there, so TestFlight is still on the previous build and check
K would be meaningless on it.

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
  install step. Then date the CODE from a string the running app logs - `git log -S "<that line>"` -
  because a log string is version-stamped evidence the process hands you for free. See rule 17 in
  [testing-methodology](testing-methodology.md).
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

1. **The Kotlin actually compiles.** A `workflow_dispatch` run of `android-release.yml` is the only
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

Test the **release** artifact from `android-release.yml`, not a local build: a locally re-signed
release cannot be installed over the existing app without an uninstall, and an uninstall costs a
re-enrolment and SETUP-4's 2FA.

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
5. **A file picker and a dialog still open.** They are the only native UI this app has, and the
   claim under test is that nothing referenced the excluded library.

**A debug pass covers none of this**, which is why this check is separate from Q - cleared on a
debug APK on 2026-08-26, on a build that by definition never ran R8.

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
