# Device verification runbook

Everything native in Canari is verified by **compiling**, which proves nothing about running. A
manual `workflow_dispatch` of either release workflow is the only way to compile Swift/ObjC/Kotlin
from a Windows machine, so that is what the mobile work has been gated on - and it is why several
Work Packages sit open with correct-looking code that has never executed on hardware.

This file is the single ordered pass that closes them.

## Where the pass stands

**Android is done except H and K.** The full ladder was run on **v0.11.7** on 2026-07-31 (log
archived on the user's desktop) after partial runs on v0.11.5 and v0.11.6. Two defects came out of
it, both tracked as WP-NOTIF-1 and both re-checked by **check K**. **Check H was recorded PASS and
was not one**: the user reported on 2026-08-01 that a tapped notification still does not open the
conversation. That is the lesson this file exists for - a check whose verdict is "it looked right"
is not a check, so H now names the log lines that decide it.

**iOS is entirely owed.** Not one check has ever run on hardware. That is what this file is now
for. The iOS half of WP-SEC-1 and WP-IOS-1 has only ever been compiled, and a green CI run is not
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

For the iOS pass, install the `ios-release` artifact of the run above rather than waiting for
TestFlight: a dispatch does not upload there, so TestFlight is still on the previous build and check
K would be meaningless on it.

## Before you start

- **A second account.** Every push check needs a peer to send from. A second phone, or the web app
  in another browser profile, both work.
- **A log capture.** iOS: Console.app or the Xcode device console, filtered on the app and on
  `fr.emse.canari.push` for the notification extension. Android (check K only):
  **`test_adb.py`** at the repo root - a tkinter GUI that builds, installs, and tails per-device
  logcat with this runbook's tags already whitelisted.
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

1. Kill the app. Have the peer send a DM, then a channel message.
2. Tap each notification. Each must land in the right conversation, **not** merely the right tab.

**Read the log, not just the screen.** This check was recorded PASS on v0.11.7 and the DM half was
broken the whole time: the tap does reach the right tab, and "right tab" is what a pass looks like
from across the room. Three lines, in order, and each one names the hop that failed if it is the
last one you see:

- `[notifNav] deep link received: fr.emse.canari://chat/<id> -> target <id>` - everything native
  worked (PendingIntent, `onNewIntent`, the deep-link plugin, `hooks.client.ts`). Absent: the
  failure is native, and none of the JS below ever ran.
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

---

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

Update SESSION STATE in `CLAUDE.md` per Work Package: what passed, what failed, and **the log lines
you actually saw**. A failure with no captured log is worth almost nothing - the whole reason
WP-FWD-1 is still open is that the one loss it describes left no trace.
