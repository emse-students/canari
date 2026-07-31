# Device verification runbook

Everything native in Canari is verified by **compiling**, which proves nothing about running. A
manual `workflow_dispatch` of either release workflow is the only way to compile Swift/ObjC/Kotlin
from a Windows machine, so that is what the mobile work has been gated on - and it is why several
Work Packages sit open with correct-looking code that has never executed on hardware.

This file is the single ordered pass that closes them. It replaces the checks that were scattered
across individual Work Packages and the delegation log that used to live in `AGENTS.md`.

**Build under test: v0.11.7** (on Play production and TestFlight since 2026-07-31). Android from
Play or the release-asset APK, iOS from TestFlight. It is the first build carrying WP-PUSH-1/2, HIST-1 and
NET-1, so checks B and C now cover the Android catch-up-first ladder and the iOS App Group cache
hop as well. Check G already passed on Android on **v0.11.6** and is not re-owed - see below.

## What each check closes

| Check | Closes |
|---|---|
| A | WP-VERIF-0 (upgrade path - the only test of the one-shot migration) |
| B, C | WP-VERIF-0 (background decrypt), WP-VERIF-2 |
| D, E | WP-VERIF-0 (PIN change, fresh install) |
| F | WP-VERIF-1 |
| G | WP-VERIF-3 |
| H | WP-DEEPLINK-1 residual |
| I | WP-UI-1 residual |
| J | WP-VERIF-4 |

## Before you start

- **A second account.** Every push check needs a peer to send from. A second phone, or the web app
  in another browser profile, both work.
- **A log capture per platform.** Android: `adb logcat` (the native side only appears there - see
  the tags below), plus the in-app log export for the WebView side. iOS: Console.app or the Xcode
  device console, filtered on the app and on `fr.emse.canari.push` for the notification extension.
- **Screen genuinely locked, app genuinely killed** for B/C. A backgrounded app is a different code
  path and passing it proves nothing about the one under test.

## Order matters

**Do check A first.** It requires the pre-WP-SEC-1 build installed and logged in *before* v0.11.7
lands over it. Once you install v0.11.7 onto a clean or already-migrated app, that opportunity is
gone until you deliberately downgrade again.

---

## A. Upgrade path: the one-shot device-key migration

**Proves** that an existing install whose device key lives in cleartext `push_context.json` promotes
that key into the platform keystore on first launch of the new build, and strips the JSON field -
without the user logging in again. This is the only test of it, on either platform.

1. Install **v0.11.3** (the last release *without* WP-SEC-1 - v0.11.4 already contains it). Android:
   the `v0.11.3` release-asset APK. iOS: the v0.11.3 TestFlight build.
2. Log in fully. Send and receive one message so the state is real.
3. Install v0.11.7 **over it**, without logging in again.
4. Launch once, then kill the app.
5. Run check B (Android) / C (iOS).

**Verdict, Android:** `CanariApp: migrateDeviceKeyFromJson: key promoted to Keystore, JSON stripped`.
The failure twin is `migrateDeviceKeyFromJson: Keystore store failed - keeping JSON field for now`,
which is a deliberate degrade rather than a crash: the key stays readable, so the app still works and
the migration retries next launch. Either line answers the check; silence means the migration path
never ran and is the interesting result.

## B. Android: decrypted push, app killed, screen locked

**Proves** the whole background chain: FCM wakes the service, the keystore hands back the device key,
the MLS state loads read-only, and the ciphertext decrypts.

1. Kill the app. Lock the screen.
2. From the peer account, send a DM with recognisable text.
3. Read the notification on the lock screen **without unlocking**.

**Pass** = the notification shows the actual message text. A generic "Nouveau message" is a FAIL -
it is the fallback for a decrypt that did not happen.

**Verdict lines** (`adb logcat`, tags `CanariFCM` and `MlsDeviceKeyStore`):

- `MlsDeviceKeyStore: retrieve: success alias=mls_bg_key_…` - the key came out of the keystore.
- `CanariFCM: tryDecrypt: MLS state loaded (N bytes), userId=… deviceId=…`
- `CanariFCM: decryptProto: success type=… -> "…"` - the decisive one.
- `CanariFCM: showNotification: … body=…` - and it reached the notification.

**Known limit, not a bug:** background decrypt is read-only and applies no commits, so a message sent
in a *newer epoch* than the persisted state cannot be decrypted and correctly falls back to the
generic text. `decryptProtoWithCommits: success after catch-up` is the in-memory catch-up path
succeeding. If a check fails, confirm which of the two you are looking at before filing anything.

## C. iOS: decrypted push, app killed, screen locked

Same procedure as B. **This is the first ever proof that iOS background decrypt works at all** - the
entire iOS half of WP-SEC-1 and WP-IOS-1 has only ever been compiled.

**Pass** = the same: real text on the lock screen, not the generic fallback.

**Where to look:** Console.app, filtered on the `fr.emse.canari.push` extension process. The Rust
`[MLS]` lines are the same code as Android's, so `[MLS] Keystore key failed to decrypt blob - key
deleted.` means the same thing here. iOS keychain service is `fr.emse.canari`, accounts
`mls_key_<alias>` and `mls_bg_key_<alias>`.

## D. PIN change, then repeat B and C

**Proves** that rewriting the device key under the same alias leaves the background reader working -
this is where a writer/reader format mismatch shows up.

1. Change the PIN in the app.
2. Repeat B (Android) and C (iOS).

**Verdict:** `[MLS][Tauri] Device key changed - state re-encrypted and persisted.` in the app log,
then a full pass of B/C. A pass on B/C *before* the change and a fail after is the signature of the
alias being written in a format its reader does not accept.

## E. Fresh install + login, then repeat B and C

**Proves** the same chain on a device with no migration history - the path every new user takes.

1. Uninstall completely. Install v0.11.7. Log in.
2. Repeat B and C.

## F. Login end to end: init, save, KeyPackage

**Proves** WP-VERIF-1. All three `invoke` names matched no Rust command from v0.11.0 to v0.11.2.
Android login demonstrably reached MLS init and SQLite on 2026-07-29, so what is still owed is the
explicit confirmation of the save and the KeyPackage publish, plus the whole iOS side.

On the login of check E, confirm in the app log:

- `[DB] Using SQLite storage (Tauri)` - and **never** the IndexedDB fallback. That fallback is a last
  resort, not a mode; seeing it means `SqliteStorage.init()` threw.
- `KeyPackage published.` - without this, no peer can invite this device.
- A relaunch restores the conversation list, which is the only proof the state was actually saved.

## G. Biometrics: enable, relaunch, disable, and the PIN modal

**Proves** WP-VERIF-3. Two of its checks passed on Android on 2026-07-29 and one failed; that failure
(a `Base64.DEFAULT` newline on the FFI wire) is fixed in v0.11.5 and needs re-confirming.

1. **Enable** biometric unlock from the profile screen. The prompt must show **two** app-supplied
   lines, not four: a title naming the action and a generic confirmation line. No string anywhere may
   name a sensor - there is no Face ID on Android and no fingerprint on a Face-ID-only iPhone.
2. **Relaunch** and unlock with the finger/face. **This is the re-run of the fixed bug:** the login
   must complete, *not* fall back to the PIN modal after a successful biometric.
   - `[BIOMETRIC] Biometric login attempt`
   - `[BIOMETRIC] Authenticating for userId=… via device keystore...`
   - `[BIOMETRIC] Skipping PIN verification - using device keystore...` &larr; the fix. Its absence
     with the two lines above present is exactly the v0.11.4 failure.
3. **The swallowed first tap - PASSED on Android, v0.11.6, 2026-07-30.** `startLoginFlow` raised
   `isLoginInProgress` for the `+layout.ts` guard and never released it before `biometricLogin`,
   so `loginImpl` refused the automatic attempt of every cold launch - deterministic, not a race.
   It now releases it like the web branch does.
   **Result:** two cold launches (16:34:47, 16:37:54) each went
   `[BIOMETRIC] Biometric login attempt` -> `Authenticating for userId=... via device keystore...`
   -> `Skipping PIN verification - using device keystore...`, OS prompt raised, no PIN modal.
   `[LOGIN] Call ignored, a login already owns the flow` appears **nowhere** in the log.

4. **The biometric session must persist its messages - PASSED on Android, v0.11.6, 2026-07-30.**
   A biometric session used to run with an empty device key in the WebView, so nothing it received
   was written to SQLite and nothing already stored could be read.
   **Result:** zero `Failed to decrypt SQLite row` across both biometric sessions, one biometric
   prompt per login, and `MLS state loaded from mls.bin (native).` naming the right backend. The
   decisive line is `[HISTORY_BUNDLE] Full history sent: 51 message(s)`: the bundle is built by
   reading the local store back with the device key, and it carries **51** where the session had
   started from a 50-message bundle - so the message received under biometrics was both written
   and read back. `[FCM_CACHE] Injection done: 1/1` confirms the same for the push cache.
5. **The PIN modal keeps its "use biometrics" button** when biometrics are enrolled. It derives that
   button from the same flag as the sheet, so if the sheet stops opening the button vanishes too.
6. **Disable** biometric unlock, relaunch, confirm the PIN is required and the keystore entry is
   really gone (the biometric sheet must not appear at all).

## H. Deep link from an OS notification tap

**Proves** the WP-DEEPLINK-1 residual. The fix is verified on the web for the two link paths; the
notification tap could not be driven from a headless browser. It publishes to `notifNav` exactly like
the two verified paths.

1. Kill the app. Have the peer send a DM, then a channel message.
2. Tap each notification. Each must land in the right conversation, **not** merely the right tab.

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

**Verdict:** tag `CanariOutboxRetry` in logcat. iOS schedules the same work as
`fr.emse.canari.outboxRetry` via `BGTaskScheduler`, which the OS runs on its own schedule - so an iOS
failure here is inconclusive rather than a defect.

---

## Traps that outlived the work that found them

Kept because each one costs a full device pass to rediscover.

- **Do NOT add `.setKeySize(256)` to `generateBiometricProtectedKeyForAlias` yet.** It only affects
  newly created aliases, so it would split behaviour between fresh and upgraded installs while the
  migration in check A is still unvalidated. Worth doing once A-E pass.
- **The Android alias `unime_dev` no longer exists.** It belonged to the UniMe legacy
  `store`/`retrieve` API, which had no caller and was deleted in v0.11.5. An install predating the
  deletion may still hold that keystore entry plus a `secure_storage` SharedPreferences blob; both
  are inert. Seeing them is not a failure.
- **An empty `deviceKeyB64` is not "no context".** Both platforms separate the two; a check that
  conflates them reads a missing key as a missing login.
- **`MlsDeviceKeyStore` uses two Base64 flavours on purpose:** `DEFAULT` for the IV/CT (that is
  KeystorePlugin's at-rest format) and `NO_WRAP` for the key it RETURNS, because `DEFAULT` appends
  a newline and the Rust `decode_base64_to_32_bytes` does not trim. Do not "unify" them.
- **The key sits in the keystore as RAW 32 bytes and crosses the FFI as base64.** Writers decode
  before storing, readers encode after loading, on both platforms and in both migrations. Treating
  the stored bytes as text yields no key, silently.

## Recording the results

Update SESSION STATE in `CLAUDE.md` per Work Package: what passed, what failed, and **the log lines
you actually saw**. A failure with no captured log is worth almost nothing - the whole reason
WP-FWD-1 is still open is that the one loss it describes left no trace.
