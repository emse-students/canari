# Mobile architecture (Tauri)

**Stack**: Tauri 2 / Rust / SvelteKit  
**Source**: `frontend/src-tauri/`

Canari runs as a native mobile app on Android and iOS via Tauri 2, using the same SvelteKit frontend rendered in a WebView. This page documents mobile-specific architecture that extends the [frontend architecture](../architecture.md).

## Key differences from Web

| Aspect | Web (browser) | Tauri (mobile) |
|---|---|---|
| MLS | WASM (`WebMlsService`) | Native Rust (`TauriMlsService` via `invoke()`) |
| State storage | IndexedDB | Filesystem (`~/.canari/`) |
| HTTP | `fetch()` with cookies | `@tauri-apps/plugin-http` (bypasses CORS) |
| WebSocket auth | `canari_ws_token` cookie | `?token=` query param (cookie not sent on cross-origin WS) |
| MLS snapshot | Argon2 in worker thread → IndexedDB | Direct filesystem write under `mls_bin_write_lock` |
| Prekeys | 50 OTKPs | 200 OTKPs (more frequent offline periods) |
| Push notifications | — | FCM (Android), APNs via FCM (iOS) |

## Native MLS

`TauriMlsService` calls Rust functions via `invoke()` instead of WASM:

```typescript
// TauriMlsService.ts
async sendMessage(groupId: string, plaintext: Uint8Array): Promise<Uint8Array> {
  return invoke('mls_send_message', { groupId, plaintext });
}
```

The Rust side is in `frontend/src-tauri/src/` (Tauri commands) and `frontend/mls-core/` (shared MLS logic, same crate used by WASM). `BaseMlsService` provides the shared `runCommitTransaction` / `stageAddMembers` / `mergePendingCommit` primitives that both `WebMlsService` and `TauriMlsService` extend.

> **The command name is an untyped string on both sides.** Nothing checks that the literal passed
> to `invoke()` matches a `#[tauri::command]` listed in `generate_handler!` in `lib.rs`; a stale or
> renamed name compiles, lints and type-checks, then fails only at runtime with "command not
> found". v0.11.0 shipped `initialiser_mls_avec_clef`, `sauvegarder_mls_et_persister_avec_clef` and
> `generer_key_packages_et_persister_avec_clef` against Rust commands that had kept their original
> names - every native MLS init, save and KeyPackage publication failed for as long as it was live.
> When renaming a command, grep both sides.
>
> The same hazard applies to **plugin** commands, with two extra ways to get it wrong: the prefix
> is the Tauri plugin name (`plugin:keystore|…`), not the Android class id, and the command must
> also appear in the plugin's `build.rs` ACL array. See
> [auth - calling the keystore plugin from JS](modules/auth.md).

### Device key on the biometric path

In biometric mode the at-rest key never reaches JS: `ctx.getDeviceKey()` stays `''` for the whole
session, so every `invoke` carries an empty `deviceKeyB64`. `initialiser_mls` resolves the key once
(`MlsManager::resolve_at_rest_key`, keystore Path A) and caches it in `AppState.device_key`; the
save and KeyPackage commands fall back to that cache. Resolving per call would instead fire one
`retrieve_device_key` BiometricPrompt per save.

### Tauri-specific MLS

- **Epoch caching**: `_epochByGroupId` + `refreshEpochCache()` — Tauri cannot read the WASM group directly, so epoch is cached and refreshed after each queue item, Welcome, and commit.
- **Queue priority**: `group_reset` control → Welcome queue → application queue.
- **Filesystem state**: MLS state persisted under `mls_bin_write_lock` (no IndexedDB).

### Local message store

Conversations, messages and the outbox live in `canari_<userId>.db`, opened by `SqliteStorage`
through `@tauri-apps/plugin-sql`. It is **frontend-only**: the native side owns a different
database, `mls_pending.db` (queued push payloads), so the two never contend for the same file.

`getStorage()` falls back to `IndexedDbStorage` when `SqliteStorage.init()` throws. That fallback
is a last resort, not a supported mode - it is a `console.warn` in a WebView, so a permanent
degradation looks exactly like a healthy start. Check for `[DB] Using SQLite storage (Tauri)` in
the logs to confirm the real backend.

**A migration outlives the schema it was written against.** Branches are keyed on
`PRAGMA user_version`, and a brand-new database starts at 0, so every historical branch runs on it.
The v1 -> v2 purge named a `salt` column that the deviceKeyB64 refactor had removed from
`CREATE TABLE messages`, and every fresh install threw `no such column: salt` and silently ran on
IndexedDB. Two rules follow, both enforced in `db/sqliteMigrations.ts` and its tests:

- A database created by the `CREATE TABLE IF NOT EXISTS` statements has nothing to migrate: stamp
  it at `SCHEMA_VERSION` and skip every branch. `user_version` alone cannot detect this - a
  pre-migration-system database also reports 0 - so the check reads `sqlite_master` **before** the
  creation statements run.
- A migration that inspects columns must build its statement from
  `PRAGMA table_info(...)`, so dropping a column can never break the migration that mentions it.

### Local storage usage (WP-DEVICESTORAGE-1)

Settings shows a breakdown of what Canari is using on the device, distinct from
[storage-forecast](../infrastructure/storage-forecast.md), which is the SERVER's disk. Two
measurement paths, because there is no single API that answers this on every platform:

- The media/avatar/association-logo Cache Storage buckets (`mediaBlobCache.ts`,
  `userAvatarCache.ts`, `associationLogoCache.ts` - each now exports its cache name for this
  reason) are measured and cleared identically everywhere: Cache Storage works inside the Tauri
  WebView too, and everything in them is re-fetchable, so this is the only thing "clear cache"
  ever touches.
- The local database above and `mls.bin` have no cross-platform size API. Native reads real file
  sizes via `get_local_storage_usage` (`src-tauri/src/commands/storage.rs`), bucketing
  `{app_data_dir}` by filename; on the web build there is no such command, so `deviceStorage.ts`
  falls back to `navigator.storage.estimate()`'s origin-wide total minus the (precisely measured)
  cache size, which folds the MLS IndexedDB store into "messages" there instead of reporting it
  separately.

`mls.bin` is reported for DISPLAY only and is never reachable from the clear action -
`get_local_storage_usage` is read-only and `clearMediaCache()` only ever calls `caches.delete()`
on the three named buckets by name, never lists the app data directory. Same shape of risk as
[WP-DIRECTBOOT-1's `getOrCreateKey`](#the-process-exists-before-the-first-unlock-and-nothing-in-it-may-assume-otherwise-wp-directboot-1)
below: a destructive control reachable from a Settings page needs an allowlist of what it may
touch, not a denylist of what to avoid.

### Opening the app with no network

A cold start with biometrics enrolled, or a device-key vault from "stay signed in", unlocks with no
server at all: the history reads from the local store above and new messages queue in the outbox.
The gate that used to prevent it was `getToken()`, not the PIN. A PIN-only user still needs a
network, because the key derives from a server-issued salt that is deliberately never cached.

The rule to carry: **the two paths that can unlock offline are exactly the two that already skip
the server PIN check when online**, so nothing is verified less. Full reasoning, and the promotion
sequence that runs when connectivity returns, in
[`modules/auth.md`](modules/auth.md#offline-unlock).

## `fetch` is not `fetch` inside the WebView

On mobile `hooks.client.ts` REPLACES `window.fetch` with the Tauri HTTP plugin's, because the
WebView's own client cannot reach a third-party origin from under the app's custom protocol. Two
consequences that nothing type-checks:

- **The plugin is a NETWORK client** in a Rust thread. It implements `http:` and `https:` and
  answers everything else with `scheme <x> not supported` - a bare rejected promise, which reads
  exactly like the network being down.
- **The routing rule must name what the plugin CAN do, never the exceptions.** It was written as an
  exception list (relative paths, the dev server, cookie-bearing calls), so `blob:` - which nobody
  had listed - went to the network client. Saving a decrypted attachment reads its object URL back,
  so **every download on both platforms failed**, showing "le telechargement a echoue" while the
  ACLs, the save dialog and `fs.writeFile` were all perfectly correct. The predicate is now
  `shouldUseNativeFetch` in `utils/fetchRouting.ts`, pure and tested.

Also verified on hardware while chasing it: `XMLHttpRequest` is NOT patched and reads a `blob:` URL
fine, so a passing XHR next to a failing `fetch` is the fingerprint of this class of bug.

## Rules that hold across both platforms

**Push is all-FCM.** One transport for Android and iOS alike: the backend sends every `PushToken`
through `getMessaging().send()`, and FCM relays to APNs using the `.p8` key configured in the
Firebase console. There is no direct-APNs path for messages (VoIP calls are the exception, see
below), which is why `FirebaseAppDelegateProxyEnabled` must stay enabled. Architecture:
[`services/chat-delivery.md`](../services/chat-delivery.md).

**Firebase 12 moved the iOS data path.** `messaging:didReceiveMessage:` no longer exists. FCM data
now arrives through the `UIApplicationDelegate` swizzle (`CanariInstallRemoteNotificationHook`) and
the `UNUserNotificationCenter` callbacks, both funnelling into `CanariHandleFcmData()`. Hook new
iOS push work there.

**Branch on the runtime helpers, not on ad-hoc checks:** `isIosTauriRuntime()` and
`isMobileTauriRuntime()` in `appVersion.ts`. Several behaviours shipped Android-only and had to be
widened to all-mobile afterwards (heartbeat, notification suppression, `reloadStateFromDisk`) —
when adding one, decide deliberately which of the two it belongs to.

**A WebView has no download manager, so `<a download>` is a silent no-op on both platforms.**
Saving a file on the web is an instruction to the *shell*, not to the page: Chrome and Safari own a
download manager, Android's WebView forwards the request to a `DownloadListener` the host app must
install, iOS needs a `WKDownloadDelegate`. Tauri installs neither. The anchor click still dispatches
and still "succeeds", so there is no exception to catch and nothing in any log — which is how eleven
download buttons shipped dead on mobile without a single report until someone tried one. Everything
that saves a file goes through `utils/fileDownload.ts`, which keeps the anchor on the web and writes
through the native save dialog on Tauri (`ACTION_CREATE_DOCUMENT` on Android, the document picker on
iOS, the OS save panel on desktop). Two rules come with it:

- **Never ask for a directory.** Android's storage access framework offers a *document* picker;
  `dialog.open({ directory: true })` has no equivalent there. `save()` is the portable shape.
- **`fs:default` is READ-ONLY.** It grants reading the app-specific directories and creating them,
  nothing more — so `fs` appearing in `capabilities/default.json` says nothing about whether a write
  is allowed. `fs:allow-write-file` is what makes this work, and like every ACL gap it builds, ships
  and installs before rejecting on a user's device. `tauriCapabilities.test.ts` pins it by command
  name. The destination itself needs no broad grant: the dialog plugin adds whatever the user picked
  to the `fs` scope.

**Kotlin nested types go on the outer class body, never inside a companion object** — declared
there they are unreachable by class name, and the failure only appears in the release build, which
is the [first real Kotlin compile](../cicd.md).

## What the app claims over `canari-emse.fr`

Tapping an `https://canari-emse.fr/…` link on a phone with the app installed opens the **app**, not
the browser, for every path the app claims. The claim is one decision carried in three files that no
compiler compares:

| File | Platform | Says |
|---|---|---|
| `lib/mobile/appSiteAssociation.ts` → `MOBILE_UNIVERSAL_LINK_PATHS` | iOS | The served `apple-app-site-association`. **Canonical.** |
| `src-tauri/tauri.conf.json` → `plugins.deep-link.mobile` | Android | Source of the generated intent-filter |
| `gen/android/…/AndroidManifest.xml` | Android | What is actually compiled into the APK |

**A path restriction written for iOS has no effect on Android.** The two platforms express the claim
in different places, and `assetlinks.json` — Android's half of the verification — has no notion of a
path at all: on Android the filtering can only live in the intent-filter. That is not a detail of
this codebase, it is how the two systems differ, and it is why the lists must be generated rather
than maintained side by side. `androidAppLinkPaths()` does the translation (`/x/*` → `pathPrefix`,
anything else → exact `path`; Android has no negation, so what is not listed is simply not claimed)
and `appSiteAssociation.test.ts` fails when any of the three drifts.

**A host with no path attribute claims the entire host.** Android shipped exactly that, so the app
captured `/auth/callback?code=…&state=…` — the OIDC redirect belonging to whichever browser had
started the login. The browser never completed its round trip and returned to the login page, on
every retry; only phones with the app installed were affected, and only in browsers that honour App
Links, which is why it read as "some people, some browsers". Never widen this claim to a bare host,
and never add a path here without asking whether a *browser* is waiting for it.

**Verify the claim, do not assume it.** `adb shell pm get-app-links fr.emse.canari` reports the
verification state on a device, and Google's Digital Asset Links API answers for the served file:

```
https://digitalassetlinks.googleapis.com/v1/statements:list
  ?source.web.site=https://canari-emse.fr&relation=delegate_permission/common.handle_all_urls
```

Both association files are prerendered by SvelteKit (`routes/.well-known/`) and served by nginx from
`build/.well-known/`, so they follow the ordinary deploy — see [`seo.md`](seo.md) for that pipeline.

### How a deep link actually reaches the app — two paths, only one of them gated

Every deep link (`fr.emse.canari://chat/<groupId>`, the OIDC callback, a Stripe return, an App Link)
enters through `hooks.client.ts`, but **by one of two mechanisms depending on whether the app was
already running**, and they do not have the same failure modes:

| The app was… | Mechanism | Needs a capability grant |
|---|---|---|
| running (foreground or backgrounded) | `onOpenUrl` — an event channel the Rust side registers | **no** |
| closed | `getCurrent()` — a plugin **command** | **yes** (`deep-link:default`) |

`deep-link` was absent from `capabilities/default.json` entirely, so `getCurrent()` rejected with
`deep-link.get_current not allowed` on every launch and every cold-start deep link was lost:
tapping a message notification with the app closed opened Canari on the default route and left it
there (WP-DEEPLINK-1, fixed `916ed696`). **A plugin declared in `Cargo.toml` and configured in
`tauri.conf.json` is still granted nothing** — see
[`development.md`](../development.md#contracts-the-compiler-does-not-check), and
`tauriCapabilities.test.ts`, which now fails on the gap.

Two consequences worth carrying:

- **The warm path passing says nothing about the cold one.** Anyone checking a deep link has just
  used the app, so they check the ungated path. `check H` in
  [`device-verification.md`](../device-verification.md) must be run **twice** — backgrounded and from
  a killed process — and that is why NOTIF-7 does.
- **This is not platform-specific.** One capability file, one `hooks.client.ts`: iOS was equally
  affected and has never been checked on hardware.

The diagnosis is cheap when a cold start misbehaves, because each hop logs separately: the OS prints
`START ... act=android.intent.action.VIEW dat=fr.emse.canari://chat/...`, the WebView prints
`[hooks] Deep-link listener registered`, the handoff prints `[hooks] Processing URL`, and the product
prints `[notifNav] deep link received`. The first absent line names the broken hop.

#### A reload used to replay the launch link, and the guard's LIFETIME is the fix (WP-RELOAD-DL-1)

`getCurrent()` answers "the last deep link this PROCESS was handed", not "the app was just started by
one" - the Rust plugin holds it for the life of the process - so the four cold-start re-reads
(immediately, then 250/750/2000 ms) must be deduplicated. The guard was a module variable, which a
WebView reload wipes, so a reload replayed a launch url fifteen minutes old and yanked the user into
whatever it pointed at. `$lib/mobile/deepLinkClaims.ts` moved it to `sessionStorage`, whose lifetime
is exactly the WebView's: **"module variable" is a LIFETIME, not a detail, and it must be chosen
against the event the state has to survive.**

**Verified on hardware 2026-08-11**, with the reproduction kept because it is what makes the pass
mean anything:

| step | result |
| --- | --- |
| cold start through `fr.emse.canari://post/<id>` (positive control) | route `/posts/<id>`, claim set - the link WAS consumed |
| park on `/posts`, full load, then `location.reload()` | still `/posts`, claim intact - **PASS** |
| delete the claim key, reload again (negative control) | back on `/posts/<id>` - **the defect, on demand** |

The negative control is the point: "the app stayed put" is also what a build with deep links entirely
dead would produce, and the third row proves the claim is the thing holding the line. The target is
an all-zero UUID matching no post - `/posts/<unknown>` stays on its route and renders "Publication
introuvable", so the assertion is about ROUTING and touches nobody's data.

## Where an update comes from

Canari ships from three places at once: Google Play (`fr.emse.canari`), the App Store
(`id6793060521`) and `app-universal-release.apk` on GitHub Releases. Only one of them is ever the
right answer for a given install, and **the app has to work it out at runtime**.

> **The Play build and the GitHub APK cannot install over each other.** The release workflow uploads
> an `.aab`, so the binary users get from Play is re-signed by **Google Play App Signing**, while the
> APK attached to the same GitHub release is signed with our upload key. Different signatures means
> Android refuses the install outright (`INSTALL_FAILED_UPDATE_INCOMPATIBLE`), and switching sides
> requires uninstalling first — which wipes `mls.bin`, the keystore entry and the whole local message
> history. So sending a sideloaded user to the Play Store is not a slightly wrong link, it is a dead
> end that ends in data loss if they follow it far enough. The update target is a **runtime fact**,
> never a build-time constant, and that is why the store URLs are plain constants in `appVersion.ts`
> with no env plumbing behind them: the thing that varies is the *install*, not the build.

`android-release.yml` must therefore keep attaching the APK to every GitHub release — it is the only
update path sideload users have.

### The install-source probe

| Step | Where |
|---|---|
| Read the installing package at startup, write it to `installer_package.txt` | `CanariApplication.recordInstallerPackage` (Kotlin) |
| Read that file back on demand | `get_installer_package` in `src-tauri/src/commands/storage.rs` |
| Map it to `'play' \| 'sideload'` and pick a target | `probeAndroidInstallSource` / `buildUpdateTarget` in `appVersion.ts` |

Kotlin uses `packageManager.getInstallSourceInfo(packageName).installingPackageName` on API ≥ 30
(`Build.VERSION_CODES.R`) and the deprecated `getInstallerPackageName` below it — `minSdk` is under
30, so the version guard is required, not defensive. `com.android.vending` is Google Play; anything
else (or nothing at all, which is what `adb install` leaves) is a sideload. No `<queries>` manifest
entry is needed: reading the installer *name* is not subject to package-visibility filtering.

The file hop is the same cross-process pattern as `push_context.json` and `get_native_flags` —
Kotlin writes into `MlsContextLoader.tauriDataDir(context)`, Rust reads the same directory through
`app.path().app_data_dir()`. It is deliberately **not** a Tauri plugin: a new local plugin forces
`gen/android/tauri.settings.gradle` and `app/tauri.build.gradle.kts` to be regenerated, which risks
clobbering the hand-maintained `AndroidManifest.xml`, and this needs no ACL, no `build.rs` and no
capability entry. Nothing type-checks either end of that path, so
`src/lib/mobile/installerPackageContract.test.ts` pins the filename, the directory helper, the
command registration in `generate_handler!` and the `com.android.vending` literal — the same role
`fcmCacheFields.test.ts` plays for the FCM cache.

A failed or empty probe resolves to `'play'` **and logs a warning**: every build carrying this code
writes the file at startup, so a miss is a real fault rather than an expected state, and Play is the
correct default for every install made from now on. `buildUpdateTarget` is kept pure (platform +
install source in, `{ kind, url }` out) so the decision is unit-testable with no Tauri runtime;
`resolveUpdateTarget` is the thin async wrapper that runs the probe, and it skips the round trip
entirely off Android, where there is only ever one possible target.

### What actually prompts

Only `minClientVersion` does. There is no optional update prompt — the store handles ordinary
updates, and `/settings` shows the installed version passively. See
[admin](modules/admin.md#platform-configuration-adminplatform) for the rollout-timing trap that
comes with raising the minimum.

## iOS specifics

### Notification Service Extension (NSE)

`canari_NSE/NotificationService.swift` is a separate target that runs when a push notification arrives while the app is killed:

- Decrypts MLS ciphertext via Rust FFI (`canari_native_decrypt_message`)
- Decrypts media thumbnails via Rust FFI (`canari_native_decrypt_media`)
- Builds visible notification content (title, body, attachment, category, badge)
- Writes decrypted messages to `fcm_message_cache.ndjson` in the App Group container, which the app drains into its own `app_data_dir` and pre-injects at boot (see "FCM message cache")
- Runs the same background MLS decrypt ladder as Android (direct decrypt → catch-up-first for local groups → Welcome-race retry for non-local groups)
- Budget: ~30 seconds; 2 MB media cap

The NSE shares data with the main app via App Group `group.fr.emse.canari`:
- `push_context.json` — device ID, user ID, backend base URL, push token. No key material: the
  device key comes from the shared keychain item `mls_bg_key_<alias>` (see
  [auth](modules/auth.md) "Where the key lives")
- `mls.bin` — read-only mirror of the persisted MLS state; the NSE never writes it
- `channel_keys.json` — read-only mirror for community/channel message decryption
- `push_secret.txt` — read-only mirror of the PushSecret for backend fetch paths

The NSE does **not** write `mls.bin`, process Welcome pushes, or drain the outbox. Those remain app-process responsibilities.

### CallKit (VoIP pushes)

When the app is killed, incoming calls use CallKit via direct APNs VoIP pushes:

1. Caller's client → `POST /api/calls/ring`
2. Backend sends APNs VoIP push (ES256 JWT, topic `<bundle>.voip`)
3. `PKPushRegistry` delivers → `CanariReportIncomingCall`
4. User answers → `pending_call_accept.json` written → accept deep link fired
5. App unlocks → TS store drains pending accept → `CallService` auto-accepts

VoIP push tokens are persisted to `voip_token.txt` and registered via `/api/mls/push/register` (`voipToken` field).

### Force-quit constraint

Once the user swipes the app away on iOS:
- **No** silent `content-available` data pushes are delivered
- **No** `BGTask` runs until manual relaunch
- Visible (`mutable-content`) alert pushes still arrive and wake the NSE
- Background state-sync only resumes on next app open

Android has no equivalent restriction.

### iOS project

`canari.xcodeproj/project.pbxproj` is **hand-maintained** (not xcodegen). Key details:
- Two targets: `Canari` (app) + `CanariNotifications` (NSE)
- Custom URL scheme, `NS*UsageDescription` keys
- `FirebaseAppDelegateProxyEnabled` — must stay enabled
- Localized `InfoPlist.strings` (fr/en `PBXVariantGroup`)
- `aps-environment: production` for TestFlight/App Store
- Provisioning profiles: two named profiles matching `PROVISIONING_PROFILE_SPECIFIER`, team "Les Rootz" `4CLNB8SR6L`

## Android specifics

### The process exists before the first unlock, and nothing in it may assume otherwise (WP-DIRECTBOOT-1)

**Our process is created before the user's first unlock after a reboot, and we never asked for
that.** `tauri-plugin-notification` merges
`app.tauri.notification.LocalNotificationRestoreReceiver` into the manifest with
`android:directBootAware="true"` and an intent filter on `LOCKED_BOOT_COMPLETED`. One
direct-boot-aware component is enough to start the process, so `CanariApplication.onCreate` runs
whether or not anything of ours is direct-boot aware - and nothing of ours is. Check the **merged**
manifest, never the source one: this declaration is invisible in
`app/src/main/AndroidManifest.xml`.

In that window, credential-encrypted storage is not open, and **the failure mode is silence, not an
error**:

| Storage | What it does while locked | Why that is dangerous |
| --- | --- | --- |
| a file under `context.dataDir` | `exists()` answers **false**; a read fails with `errno 126 (Required key not available)` | every `if (!file.exists()) return` reads as "nothing to do" when it means "cannot tell" |
| `SharedPreferences` | loads **empty**, and the instance is cached for the life of the process | a later unlock repairs nothing - the fix is to never open it, not to re-read it |
| an AndroidKeyStore alias | may be **present and unreadable** | indistinguishable from missing, from `getKey` alone |

The defect this produced is the third row taken for the second. `PushSecretKeystore.getOrCreateKey`
treated an unreadable key as a corrupt one - the recovery it was written for is a TEE wipe - and so
it **deleted the alias and generated a new one**. That is a permanent loss caused by a temporary
condition: the ciphertext in `canari_push_prefs` was encrypted under the old key and is orphaned for
good, and the process then serves push with a credential the server rejects. The user-visible tip
was a missing avatar in a notification after a reboot; the same `verifyPushSecretAuth` guards the
encrypted-media proxy and `fetchProtoFromBackend`, the fallback that pulls a message's ciphertext
when the FCM payload does not carry it - so the same 403 costs a MESSAGE, not a picture.

The rules that follow, and they apply to anything added to this startup path:

- **Ask `DirectBoot.storageReadable()` before touching CE storage**, and treat `false` as "come back
  later", never as "the data is gone". `CanariApplication.onCreate` now defers every
  storage-backed initialiser and re-runs them on `ACTION_USER_UNLOCKED` (a runtime receiver - that
  action cannot be declared in a manifest).
- **A destructive repair must be gated on knowing the state is really broken.** `containsAlias`
  separates "absent" (a fresh install, generate) from "present but unreadable" (refuse, and say so).
- **Only notification CHANNELS can be created pre-unlock**, because they live in the system rather
  than in our storage.
- **A 401/403 on a push-authenticated fetch is an auth failure and must be logged as one.** It sat
  at debug level among the ordinary avatar misses, which is exactly why it went unseen.

#### Verified on hardware, 2026-08-11 - and the open question was DISSOLVED, not answered

A real reboot on A1, with the pid carried across both halves because a clean run on a process that
was never born locked measures nothing:

| What the WP claimed | What the fixed build did |
| --- | --- |
| the process is created pre-unlock | still true, and expected: `FirebaseApp: Device in Direct Boot Mode: postponing initialization`, pid 3562 |
| `onCreate` runs blind against locked storage | it now **detects** it: `CanariApp: onCreate: storage locked (pre-unlock process) - deferring init to ACTION_USER_UNLOCKED` |
| `recordInstallerPackage` fails with `errno 126` | 0 occurrences - the initialiser is deferred, so it never touches CE storage while locked |
| `getOrCreateKey` deletes an intact alias | 0 occurrences of the destructive branch; the Keystore is not read at all in that window |
| the process serves push degraded for its whole life | **same pid 3562** after `USER_UNLOCKED`: `MlsDeviceKeyStore: retrieve: success`, then a PushSecret-authenticated HTTP fetch that SUCCEEDS |
| some read yields a secret production rejects | 0 `push secret REJECTED` over the whole session |

The last row is the point, and it is worth stating precisely: the WP left open *which* read produced
the rejected secret, and shipped a distinct log line per branch to settle it. **No branch ever
produced one.** The question is dissolved rather than answered - the temporary-condition-as-permanent-loss
was the whole mechanism, and once the destructive recreate cannot run there is no orphaned ciphertext
to present.

**The positive proof needed a trick, because absence of a rejection is not evidence of success.** The
process had cached both avatars long before, so nothing PushSecret-authenticated was being exercised
and the run was correctly VOID. The build is DEBUGGABLE, so `adb shell run-as fr.emse.canari rm
files/avatar_*.jpg` emptied the cache under the born-locked process, and the next push produced
`fetchAvatar: avatar cached for ...` twice from pid 3562 - which is the log emitted **after** an HTTP
fetch succeeds and is written, distinct from `fetchAvatar: from cache for ...`. Two success logs one
word apart is a trap worth knowing before reading any of this: only one of them proves the network
path ran.

### Push notification handling

`CanariFirebaseMessagingService.kt` — the single FCM handler:

- `onMessageReceived` — processes data pushes (MLS messages, calls, channel events)
- Decrypts messages via JNI (`nativeDecryptMessage`)
- Decrypts media thumbnails via JNI (`nativeDecryptMedia`)
- Shows notifications: MessagingStyle for messages, CallStyle for calls
- Quick actions: Reply (text input) and Mark as Read (broadcast to `CanariNotificationActionReceiver`)

MessagingStyle takes two `Person`s and **both** need an icon. The sender's comes from `fetchAvatar(senderId)`; ours comes from `fetchAvatar(loadUserId())` - Android attributes the inline reply to the self `Person` while the reply is in flight, so an iconless self is a blank face on the only message in that thread the user actually wrote. `MlsContextLoader.loadUserId` reads just the `userId` field of `push_context.json`, deliberately not `loadPushContext`, whose expensive half is a Keystore round trip this caller has no use for. iOS shows a single attachment image rather than a thread, so it has no self `Person` and nothing to fix there.

#### Background MLS decrypt ladder

Both Android and the iOS NSE run the same ladder when an encrypted MLS message push arrives:

1. Try a direct decrypt (`tryDecrypt` / `decryptProto`).
2. If that fails and the group is already local (`isGroupLocal` → epoch ≥ 0), run in-memory commit catch-up (`tryDecryptWithCommitCatchup` / `decryptWithCommitCatchup`) immediately.
3. If the group is **not** local, retry a few times to give a concurrent Welcome push time to join the group (`WELCOME_RACE_RETRIES × WELCOME_RACE_RETRY_DELAY_MS` = 3 × 1.8 s on Android, mirrored by `welcomeRaceRetries × welcomeRaceRetryDelayMs` in the NSE).
4. If the group becomes local during that race, try commit catch-up as a last resort before falling back.
5. If everything fails, Android enqueues `MlsBackgroundWorker` and shows the generic fallback notification (unless the push is silent, in which case it returns quietly). The iOS NSE cannot enqueue work from the extension, so it shows the fallback directly.

This order matters because a silent commit push advances the epoch but cannot persist state while the app is closed; the next message push therefore looks like an epoch gap on a group that is already joined. Running catch-up first for local groups avoids the old ~9.6 s retry loop.

### FCM message cache

Both platforms write decrypted message previews to `fcm_message_cache.ndjson` after a successful decrypt:

- Android: `CanariFirebaseMessagingService.writeFcmCache` → `{app_data_dir}` directly. The FCM service runs in the app's own process, so it shares that directory.
- iOS NSE: `NotificationService.writeFcmCache` → the **App Group container**, then `CanariDrainAppGroupFcmCache` (called from `canari_ios_bootstrap` and on `didBecomeActive`) moves the entries into `{app_data_dir}`.

That extra hop is not optional: an app extension has its own data container, so `app_data_dir` resolved inside the NSE is a directory the app can never read. The App Group is the only storage the two processes share — the same reason `mls.bin` is mirrored there. The NSE also writes with `completeFileProtectionUntilFirstUserAuthentication`, because it runs on a locked device where the default protection class cannot be written.

The file is bounded to 50 entries and read at boot by `read_and_clear_fcm_cache` (Rust) so the app can pre-inject messages into the local store before the full MLS sync finishes. Both writers must produce the same JSON fields (`groupId`, `messageId`, `senderId`, `senderName`, `content`, `timestamp`, `type`, plus optional `replyTo` and `mediaKind`). `fcmCacheFields.test.ts` pins the fields **and** both halves of the iOS path - off macOS it is the only gate on either.

**The cache also carries OUTGOING messages, not only received ones.** A notification quick reply is built and delivered entirely natively (`writeSentMessageToCache` on Android, `CanariWriteSentMessageToCache` on iOS), so it never becomes a TypeScript outbox entry - and `reconcileOutboxSent` only *deletes* entries. Without an entry here, a reply the peers received would leave no trace whatsoever on the device that sent it, which from the app is indistinguishable from a reply that was never sent. The entry carries OUR user id as `senderId`, which is all the injection path needs: `mapStoredMessagesToChatMessages` derives `isOwn` from it, so the row renders as our own message and raises no phantom unread. It is written only once the drain reports the reply delivered - an undelivered reply must not appear as sent.

An undelivered quick reply is kept in `outbox_pending.ndjson` only, and `store_outbox_mirror` **rewrites** that file from the TypeScript queue — which has never heard of an entry the native side appended. That used to erase it on the next foreground outbox mutation. `adoptOrphanedMirrorEntries` closes it: see [Outbox mirror](#outbox-mirror) below. The notification is still left up as the immediate retry affordance, since adoption only happens at the next login.

### Background execution

- **WorkManager** (`OutboxRetryWorker`): exponential backoff retry for unsent outbox messages
- **BootReceiver** (`CanariBootReceiver`): re-registers FCM token + drains outbox on boot
- **Foreground guard**: retry is deferred when the TS outbox flusher is active

### Outbox mirror

Both platforms maintain an `outbox_pending.ndjson` mirror for background sends:

- TS writes to the mirror on every outbox append (`syncOutboxMirror` → `store_outbox_mirror`, a full rewrite, never an append)
- Background path reads + drains the mirror
- Preserves `silent` flag per entry
- Shared drain path: encrypt via JNI/FFI → POST `/api/mls/push/send`

The mirror is not one-way, and that is the part worth remembering. The native quick reply **appends** to it, so an entry can exist there that the TypeScript outbox has never heard of — and since `store_outbox_mirror` rewrites the file wholesale from the TS queue, the next foreground mutation would delete it. Two passes keep the two sides in step, and they are twins:

| Direction | Pass | What it does |
|---|---|---|
| native → TS, delivered | `reconcileOutboxSent` (`read_and_clear_outbox_sent`) | drains `outbox_sent.ndjson` and **deletes** the matching outbox entries |
| native → TS, undelivered | `adoptOrphanedMirrorEntries` (`read_outbox_mirror`) | **creates** an outbox entry, plus the local message, for every mirror line the TS queue does not know |

Notes on the adoption pass:

- It runs **before** `loadAndRestoreConversations`, so the adopted message is picked up by the ordinary history load and marked `pending` by `applyOutboxPendingStatuses` — there is no separate in-memory merge path to keep correct.
- `read_outbox_mirror` deliberately does **not** clear the file: the mirror stays authoritative for the background service until the next rewrite.
- The proto is decoded, not replayed opaquely, so an adopted entry becomes a first-class `text`/`reply` that the flusher re-encodes identically (same `messageId`, same `sentAt`). A `silent` entry stays `control` — sent verbatim and without a push, which is what silent means. Anything else logs and is left alone.
- A delivered send is removed from the mirror by the native drain, so an entry still present was not delivered. Should one race through, `reconcileOutboxSent` deletes it moments later; adoption is idempotent on the stable `messageId` either way.

#### The drain is a BATCH, and every part of its shape is load-bearing (WP-ANR-1, 2026-08-11)

The drain used to call the single-message native entry point once per queued message. Each call
re-read `mls.bin`, CBOR-decoded the entire OpenMLS keystore, encrypted one message, re-serialised
the whole keystore and wrote it back — `O(N x |mls.bin|)` on a 2.7 MB file, inside the **60 s the OS
allows a `goAsync()` BroadcastReceiver**. With the per-byte decode below multiplying it, that is
what ANRed the app from `CanariBootReceiver`, which fires after every Play Store update.

`send_messages_background_with_key` (`src-tauri/src/mobile/background.rs`) is now the one entry
point on both platforms — `nativeSendMessagesBackground` on Android,
`canari_native_send_messages_background` on iOS — and the platform loops only POST. Four properties,
each of which a plausible-looking implementation gets wrong:

| Property | Why it is not optional |
|---|---|
| **One load, one save** | The whole point: `O(\|mls.bin\| + N)` instead of `O(N x \|mls.bin\|)`. |
| **The save precedes any returned ciphertext** | A frame handed to the caller **is** a frame the caller POSTs. Returning one whose ratchet advance is not yet durable is exactly WP-LOSS-1: the sender rewinds and the peer can never decrypt what follows. A save failure therefore discards the entire batch. `one_load_and_one_save_cover_every_advance_in_the_batch` proves it by sending a further message from the *reloaded* file and having the peer decrypt it — a save that persisted only the first advance fails there and nowhere else. |
| **The batch is capped (`DRAIN_MAX_BATCH` / `kCanariDrainMaxBatch`, 100)** | The cap is on the ENCRYPT, not on the POST. Encrypting consumes a generation whether or not the frame is ever sent, so encrypting a backlog the drain has no time to deliver runs this sender ahead of the peer — eventually past OpenMLS's maximum forward distance, which is `GenerationTooFarAhead` and **no retry repairs it**. The surplus is not touched at all. |
| **Per-entry failures are isolated** | One group not yet joined on this device (`GroupNotFound`) must not strand the rest of the backlog. Each entry gets its own result; the id is echoed so a caller cannot mis-zip its own list. |

Two bounds sit on top of the POST loop, and they are different in kind. `DRAIN_POST_BUDGET_MS`
(35 s) is the safety net for a slow network: it leaves already-encrypted frames unsent, so it is the
abnormal exit, not the normal one — the cap above is what makes the normal case fit. And the mirror
is rewritten every `DRAIN_CHECKPOINT_EVERY` (25) deliveries rather than only at the end, because the
mirror is the *only* record of what is still owed: between two rewrites, a hard kill re-sends
everything already delivered. That bounds the duplicate window instead of letting it be the whole
backlog.

The shared logic is host-testable: `mod mobile` is gated on `any(android, ios, test)`, so
`cargo test` in `src-tauri` runs the batch tests (and the `proto_fields` tests, which were
device-only before) without a device build.

### Keyboard media (Android)

`KeyboardMediaBridge.kt` intercepts `InputConnection.commitContent` to handle GIF/sticker commits from the soft keyboard. Dispatches `canari-keyboard-media` DOM events picked up by `MainChatPage` → routed through the normal media pipeline.

### OIDC login opens a Chrome Custom Tab (WP-OIDC-TAB-1, shipped and verified 2026-08-08)

`startOidcLogin()` (`auth.ts`) used to open the Authentik login with `openUrl` from `tauri-plugin-opener` on every mobile platform - a plain `ACTION_VIEW` launch. On Android this left the browser tab behind after login: `openUrl` opens in a task with no relationship to the app's own, so once the `fr.emse.canari://callback` deep link brought the app back to the foreground, nothing on either side could close the tab it left sitting on Authentik's last page.

The fix is `tauri-plugin-customtabs` (`frontend/src-tauri/plugins/tauri-plugin-customtabs/`), a small Android-only mobile plugin (one command, `open_custom_tab`) that opens the URL via `androidx.browser.customtabs.CustomTabsIntent` instead. A Custom Tab shares the **launching app's own task**, which is what lets the OS close it automatically the instant that task's activity resumes - confirmed live via `adb shell dumpsys activity activities`: the tab's `ActivityRecord` shared the app's task id right after `startOidcLogin()`, and was gone from that task's history entirely the moment the deep link returned. `auth.ts` now branches on `isAndroidTauriRuntime()` specifically (not the broader `isMobileTauriRuntime()`) - iOS keeps the plain `openUrl` launch, since its equivalent fix (`ASWebAuthenticationSession`) is a separate native surface not built here.

**Why this needed a real plugin and not a few lines of Rust JNI.** This app already has a working Rust → Kotlin JNI call (`flush_webview_cookies` in `commands/cookies.rs`, calling `CookieManager.getInstance()`/`.flush()`), and its own comment explains exactly why that pattern does not generalise: a JNI-attached native thread has no Java frames on its stack, so `FindClass` only reaches boot-classpath **framework** classes. `android.webkit.CookieManager` is one; `androidx.browser.customtabs.CustomTabsIntent` (bundled into the APK's own dex, like `MainActivity` itself) is not, and would fail to resolve the same way calling into `MainActivity` directly would. Tauri's own plugin-invocation mechanism (`@TauriPlugin`, `Plugin(activity)`) runs Kotlin code with the correct classloader context for exactly this reason, which is why the fix is a full (if minimal) mobile plugin, following `patches/tauri-plugin-keystore`'s structure - `Cargo.toml`/`build.rs`/`src/mobile.rs` on the Rust side, `CustomTabsPlugin.kt` + a Gradle module on the Android side - rather than extending the raw-JNI pattern.

`keyboardViewport.svelte.ts` pins the shell to the visual viewport while the keyboard is up:

```
--app-viewport-height: <visualViewport.height>px
```

**That height is the whole visual viewport, and the shell does not start at its top.** An ancestor
carries the status-bar inset, so on A1 (Pixel-class, 411x914 CSS, `devicePixelRatio` 2.625) the
shell begins at y=51 and is then made 571.81 px tall - bottom at 623, i.e. **51 px underneath the
keyboard**. Everything anchored to the shell's bottom goes with it, and the composer footer
(`position: absolute; bottom: 0`, height 78) is the one the user notices: they are typing into a
box the keyboard covers.

Measured on device 2026-08-06, keyboard open:

| | value |
|---|---|
| `window.innerHeight` | 914 (the layout viewport does **not** shrink here) |
| `visualViewport.height` | 571.81 |
| `--app-viewport-height` | 571.81px |
| `--keyboard-inset-bottom` | 342.19px |
| `--keyboard-layout-inset-bottom` | **0px** |
| `.app-layout` rect | top 51, bottom 623, height 571.81 |
| composer footer rect | top 545, bottom 623 |

The invariant to restore is `shell bottom <= visual viewport bottom`: the pinned height is the space
below the shell's own top, not the viewport's full height.

**First attempt (same day) was wrong and was reverted.** It fixed `computeSnapshot` to subtract a
new `shellTop` measurement (`.app-layout`'s own `getBoundingClientRect().top`) from
`--app-viewport-height`, on the reasoning that the var should already be "the space below the
shell's own top" at the source, rather than patching every CSS consumer with its own
`- env(safe-area-inset-top)` the way the desktop `AppSidebar` already does. That reasoning was
right for `.app-layout` **considered alone** and wrong for the system as a whole: `.app-layout`'s
own ancestor chain - `routes/+layout.svelte`'s `h-[var(--app-viewport-height,100dvh)]` wrapper,
whose `padding-top: env(safe-area-inset-top)` **already** reduces its content box by the same
inset, unconditionally, whether or not the keyboard is open - was *already* correctly shrunk by
that same variable. Subtracting the inset a second time, inside the variable itself, meant
`.app-layout` (still separately pinned to `height: var(--app-viewport-height)` via
`html.keyboard-open .app-layout {...}`) ended up **shorter than its own already-shrunk immediate
parent** by exactly the inset amount - a gap of that size opened between the shell's real bottom
and the keyboard, revealing the page background behind it (a visibly different color, which is
what caught this on re-test: the user's screenshot showed a lavender strip above the keyboard that
had no business being there).

Measured live over CDP (`tools/cross-client-harness/cdp.mjs`, `adb forward tcp:9222
localabstract:webview_devtools_remote_<pid>`) on a Xiaomi/HyperOS phone, keyboard open, WITH the
first (wrong) fix applied:

| element | rect | note |
|---|---|---|
| `.app-layout` | top 0, bottom 495, height 495 | `--app-viewport-height` = 495px (534 vvHeight - 39 shellTop) |
| its immediate parent (`page-scroll-wrap`) | top 39, bottom 495, height 456 | sized from the OUTER ancestor's content box: 495 (outer height, same var) - 39 (outer's own padding-top) |
| visible viewport bottom | 534 (`offsetTop 0 + vvHeight 534`) | |

`.app-layout` (495 tall) was **taller** than the box it sits inside (456 tall) by exactly 39 -
the double-subtracted inset - and the browser scrolled the (nominally `overflow:hidden`,
`page-scroll-wrap:has(.app-layout)`-gated) container to its far scroll position to keep the
focused composer in view, revealing the 39px sliver of empty space above `.app-layout`'s
now-too-tall box instead of clipping it.

**The real fix (2026-08-07) deletes the redundant CSS rule instead**:

```diff
- html.keyboard-open .app-layout {
-   height: var(--app-viewport-height, 100dvh);
- }
```

`.app-layout` was never supposed to re-consume `--app-viewport-height` independently of its
parent chain - every intermediate layer between the outer ancestor and `.app-layout` (`flex-1`,
`absolute inset-0`, `height: 100%`) is a pure proportional fill, so once the OUTER ancestor shrinks
(which it already did, unconditionally, before any of today's changes), the shrink cascades down
correctly on its own with the inset subtracted exactly ONCE, at the top. `computeSnapshot` is back
to its original, simpler `viewportHeight: m.vvHeight` - the `shellTop` field, `readShellTop()`, and
the tests pinning them were all removed along with it. Re-measured live after the fix, same device,
keyboard open: `.app-layout` rect = `{top: 39, bottom: 534, height: 495}` - bottom lands exactly on
the visible viewport's bottom (534), matching the composer footer's own rect. Confirmed visually by
the user afterward.

**A second, independent bug found in the same investigation: the phone's system nav bar had NO
reserved gap at all when the keyboard was closed.** `MainActivity.kt` never called
`enableEdgeToEdge()`. Targeting `compileSdk`/`targetSdk` 36 means Android 15+ *enforces*
edge-to-edge regardless of app code, but that enforcement is OS-version-gated and, on this
Xiaomi/HyperOS device (Android 16), the WebView still reported `env(safe-area-inset-bottom)` as
`0px` with the keyboard closed - measured directly via CDP, not inferred. Since this app's CSS
assumes edge-to-edge pervasively already (`env(safe-area-inset-top)` padding on the root layout,
`env(safe-area-inset-bottom)` on the composer footer, on `LoginForm`, `Sidebar`, `CallOverlay`,
`MediaLightbox`, `PdfViewerModal`, and more), the fix is to stop depending on OS-enforced defaults
and just call `enableEdgeToEdge()` explicitly in `onCreate` (before `super.onCreate`, same
ordering constraint as `installSplashScreen()`). Re-measured after the fix: `env(safe-area-inset-
bottom)` = `16px` with the keyboard closed on the same device - a real, non-zero gap above the nav
bar for the first time.

A third, smaller bug rode along in `app.css`: the composer footer's own bottom-padding floor was
`max(0.75rem, env(safe-area-inset-bottom))` with the keyboard closed but `max(0.5rem, ...)` with it
open - two different `git blame`d origins, no comment or rationale anywhere, the keyboard-open one
introduced by a commit literally titled "fix a lot of things". Combined with `env(safe-area-inset-
bottom)` collapsing to `0px` whenever the keyboard is open (confirmed live: the gesture-bar inset
doesn't exist once the keyboard covers that area), the composer's reserved space genuinely differed
between the two states - 12px vs 8px - which read as "the space below the input keeps changing."
Unified to `0.75rem` in both states (`.chat-composer-footer`, `.keyboard-open .chat-composer-footer`,
and their `.mobile-convo-open` mirrors) so the reserved space does not visibly shrink just because
the keyboard opened.

The same investigation also found a fourth, independent bug in `app.css`'s `.chat-messages-scroll`
padding: `--chat-composer-height` (the composer footer's real `offsetHeight`, via `ResizeObserver`
in `ChatComposer.svelte`) already includes the footer's own `env(safe-area-inset-bottom)` padding,
but the base rule and the `.keyboard-open` rule both added it a second time on top - only the
`.mobile-convo-open` rule had it right, and it lost to `.keyboard-open` by CSS source order
whenever both classes were active (mobile chat + keyboard open) - exactly the state a phone is in
while typing. Fixed by dropping the redundant addition from both rules; the guessed fallback
constants used only while the var is unset keep their own `env()` addition, since a fallback never
included it in the first place.

Two other things the measurement settles, both worth keeping:

- **`layoutInsetBottom` is dead on this path.** `computeSnapshot` sets it only when
  `isOpen && !layoutShrunk`, and `layoutShrunk` is true as soon as `winH - vvHeight > threshold*0.35`
  - which is precisely what "the keyboard opened without resizing the window" looks like. So
  `--keyboard-layout-inset-bottom` reads 0 exactly when it is needed. Whether that is the same
  defect or a second one is not established; do not assume.
- **How to reach it:** tap the composer (renders correctly), press HOME, return to the app. The
  keyboard comes back and the shell is never re-laid-out for it. A pure `focus()` from script
  reaches a different broken state - a large gap between the content and the keyboard - so the
  variable is mis-set in both directions and the repro that matters is the ordinary gesture.

## Shared native code

Rust FFI functions shared across both platforms via `frontend/src-tauri/src/mobile/`:

| Module | Purpose |
|---|---|
| `background.rs` | Background message decrypt, media decrypt, outbox drain |
| `proto_fields.rs` | Minimal protobuf encoder (no TS runtime in background) |
| `*_ffi.rs` | Platform-specific FFI exports (JNI for Android, C-ABI for iOS) |

Key FFI functions:
- `nativeDecryptMessage` / `canari_native_decrypt_message` — MLS decrypt in background
- `nativeDecryptMedia` / `canari_native_decrypt_media` — Media blob decrypt
- `nativeBuildTextMessageProto` / `canari_native_build_text_message_proto` — Reply proto encoder
- `nativeBuildReadReceiptProto` / `canari_native_build_read_receipt_proto` — Read receipt proto encoder

## Android / iOS parity, and where it is actually guaranteed

**Code parity was audited file by file at v0.12.0 (2026-08-03) and holds.** The residual
asymmetries are imposed by the operating systems and are not defects: no boot broadcast on iOS,
CallKit against a full-screen intent, no self `Person` on iOS, and a quick-reply action that
relaunches a killed process on iOS where Android uses a broadcast receiver.

**That audit read SOURCE files, so it structurally could not see a divergence expressed in
CONFIGURATION** — and every parity defect found since has been exactly that. A second pass on
2026-08-07 covered the configuration surface; what it found and what now guards each one:

| Surface | Expressed in | State |
|---|---|---|
| Plugin ACL (`deep-link`, and every other plugin) | `capabilities/*.json` — **shared** | Was missing for `deep-link`, breaking **both** platforms' cold-start deep links. Fixed; `tauriCapabilities.test.ts` guards it |
| App Link **hosts** | `appSiteAssociation.ts`, `AndroidManifest.xml`, `canari_iOS.entitlements` | iOS claimed `applinks:www.canari-emse.fr` alone, which can never validate (`www` 301s, and Apple does not follow redirects). Removed; `appSiteAssociation.test.ts` now asserts all three agree |
| App Link **paths** | the same three files | Generated from one list, already guarded |
| Custom URL scheme | `AndroidManifest.xml` (per host), `Info.plist` `CFBundleURLTypes` (per scheme) | Equivalent by construction: iOS claims the scheme, so all five hosts follow |
| `push_context.json` fields | Rust writer, three native readers | `pushContextFields.test.ts` |
| FCM manifest entries | `AndroidManifest.xml` | `androidFcmManifest.test.ts` (Android-only by nature) |
| Cookie-jar durability | `commands/cookies.rs` | Android-only **by API**, not by decision — iOS has no flush to call and has never been observed. `check P` |

Two rules come out of that table, and they are the ones to apply before adding anything native:

- **Parity of code is not parity of the manifests, entitlements and served association files.** Those
  are a separate surface with its own tests — and it is the surface every divergence has been on.
- **A no-op on one platform must say WHY.** "Nothing to do here" and "there is no API for this and
  nobody has looked" are different statements, and only the first is evidence of parity. Where the
  answer needs hardware, it becomes a lettered check in
  [`device-verification.md`](../device-verification.md) rather than a comment implying safety.

**iOS has never run a single check on hardware**, so nothing below the test line is verified there.
Until it can be, parity is maintained by construction — one shared file wherever the platforms can
share one, and a test reading both trees wherever they cannot.

## CI/CD

| Workflow | Output |
|---|---|
| `ios.yml` | `.ipa` for TestFlight (uses `altool`) |
| `android.yml` | `.aab` for Google Play |
| `appimage.yml` | `.AppImage` for Linux desktop |
| `bump-version.yml` | Bumps `MARKETING_VERSION` across iOS + Android |

See [`cicd.md`](../cicd.md) for the full pipeline.

## See also

- [`frontend/architecture.md`](../architecture.md) — SvelteKit architecture, stores, routing
- [`frontend/mls-wasm.md`](../mls-wasm.md) — WASM MLS client (Web counterpart)
- [`frontend/modules/calls.md`](modules/calls.md) — CallKit and call signaling
- [`services/chat-delivery.md`](../services/chat-delivery.md) — Push notification backend (FCM, APNs VoIP)
- [`cicd.md`](../cicd.md) — Mobile build workflows
