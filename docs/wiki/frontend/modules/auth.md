# Auth module

**Routes**: `src/routes/login/`, `src/routes/auth/callback/`  
**Components**: `src/lib/components/auth/`  
**Store**: `src/lib/stores/auth.svelte.ts`

## Responsibilities

- OIDC login via Authentik (redirect flow with PKCE).
- Dev login (email/password) when `ENABLE_DEV_ROUTES=true`.
- Access token management (in-memory only).
- Refresh token rotation via HttpOnly cookie.
- WebSocket auth cookie (`canari_ws_token`) synchronization.
- PIN setup and verification (used to encrypt MLS state).

## Login flow

```
/login -> startOidcLogin()
  -> redirect to Authentik /authorize (PKCE + state)
  -> callback to /auth/callback?code=...&state=...
  -> POST /api/auth/oidc/callback { code, redirect_uri }
  -> store access_token in memory
  -> set canari_ws_token cookie
  -> redirect to /chat
```

## Routes

| Route | Description |
|---|---|
| `/login` | Login page (OIDC button + optional dev form) |
| `/auth/callback` | Receives OIDC auth code, completes login |

## Auth store

```typescript
// auth.svelte.ts
export const currentUser: Writable<User | null>;
export const accessToken: Writable<string | null>;

export function setWsSessionCookie(token: string): void;
export function clearWsSessionCookie(): void;
export async function refreshAccessToken(): Promise<string | null>;
export async function logout(): Promise<void>;
```

`apiFetch.ts` intercepts 401 responses: it calls `refreshAccessToken()` once and retries. If refresh fails, it clears the session and redirects to `/login`.

### A status parsed back out of a sentence is a status that was discarded

`+layout.ts` logged a user out on `String(error).includes('(404)')` - matching a number
`fetchUserProfile` had formatted into its own message a moment earlier. The status is the ANSWER;
carry it as a field (`UserProfileFetchError.status` in `stores/user.ts`) rather than printing it and
reading it back. Only a 401 or a 403 may end a session, so the branch that needs the status is
exactly the branch that must not guess it.

Corollary for any audit of a seam like this: **one surface handling a case is not "the case is
handled"**. Enumerate the CONSUMERS of the seam, never just the ones whose source mentions it.

## PIN and device key

The PIN itself never encrypts anything and never leaves the device. It is the input to two
domain-separated PBKDF2-SHA256 derivations over the same server-issued salt:

| Derivation | Where | Iterations | Used for |
|---|---|---|---|
| `computePinVerifier` | `crypto/pinVerifier.ts` | 100 000 | Sent to `POST /api/mls/security/pin-check`; detects a PIN changed on another device |
| `deriveDeviceKeyB64` | `crypto/deviceKey.ts` | 310 000 | 32-byte at-rest key (`deviceKeyB64`) - the only thing that decrypts `mls.bin` and local messages |

`deviceKeyB64` is the single at-rest key: `mls.bin` is ChaCha20-Poly1305 (`[nonce 12 || ct]`),
local messages are AES-256-GCM (`[iv 12 || ct]`). Rotating the PIN re-derives the key and
re-encrypts both (`utils/chat/pinChange.ts`).

**PIN policy** (`utils/chat/pinValidation.ts`): at least 4 characters, no upper bound and no
character-set restriction, checked by the single `isValidPin` on every path (first setup, PIN
change, recovery, unlock). The rule is deliberately uniform: the device key derives from the
exact string typed, so any check a PIN could pass at creation but fail at unlock would lock its
owner out of their own messages.

### Where the key lives

| Storage | Written by | Purpose |
|---|---|---|
| Device key vault (`utils/deviceKeyVault.ts`) | PIN login | AES-GCM-wrapped key in `sessionStorage`, or `localStorage` when "stay signed in" is on (`canari_device_key_persist`) |
| Platform keystore, alias `mls_device_key_{userId}_{deviceId}` | `store_push_context` (Tauri) | Biometric unlock **and** background FCM/NSE decryption - the only at-rest copy on a device |
| `push_context.json` | `store_push_context` (Tauri) | `userId`, `deviceId`, `baseUrl`, `pushToken` only. Since WP-SEC-1 it carries **no key material** |

"Stay signed in" moves the **device key** across a restart, never the PIN - the PIN has not been
persisted anywhere since v0.11.0. The user-facing copy (`auth_pin_stay_signed_in_desc`,
`profile_stay_signed_in_desc`) must say so: describing the wrong secret on a security control is a
defect in the control.

Enrolling biometrics wipes the vault (`clearDeviceKeyAndWrapKey`) and turns "stay signed in" off,
so the next launch goes through the keystore. A PIN change must **not** delete the keystore entry:
`IMlsService.changeDeviceKey` has already overwritten it with the new key.

**The background copy is a second keystore entry, not a second file.** A push handler runs with no
user present, so it cannot satisfy a biometric gate - but it still needs the device key. Each
platform therefore keeps one entry that is hardware-backed yet usable unattended:

| Platform | Entry | Why it is readable in the background |
|---|---|---|
| Android | same alias, `setUserAuthenticationRequired(false)` | Read without an Activity by `MlsDeviceKeyStore` (Context-only). **Never** `setUnlockedDeviceRequired(true)` - that makes the key unusable while the screen is locked, which is exactly when a push arrives |
| iOS | second item, account `mls_bg_key_<alias>` | `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` and **no** `kSecAttrAccessControl`; shared with the NSE through access group `group.fr.emse.canari` |

Enabling biometrics changes the unlock *method*, never where this copy lives. Installs predating
WP-SEC-1 hold the key in `push_context.json`; a one-shot migration
(`CanariApplication.migrateDeviceKeyFromJson`, `CanariMigrateDeviceKeyFromJson`) promotes it to the
keystore at the next app start and strips the field. The background readers have **no** JSON
fallback, so one push before that first launch shows generic text.

### The key is raw bytes at rest and base64 on the wire

The device key is stored as **raw 32 bytes** in both platform keystores, and crosses the Rust FFI
as **base64**. Writers (`storeKeyBytes`, `MlsDeviceKeyStore.store`, both one-shot migrations) decode
before storing; readers (`getKeyBytes`, `CanariRetrieveDeviceKey`,
`NotificationService.retrieveDeviceKey`, `MlsDeviceKeyStore.retrieve`) encode after loading.
Treating the stored bytes as text anywhere in that chain silently yields no key - random key bytes
are almost never valid UTF-8, so the reader returns nil and every push falls back to generic text.
`pushContextFields.test.ts` asserts the contract across all five files.

On Android there is a second encoding trap: **`Base64.DEFAULT` appends a newline**, and the Rust
`decode_base64_to_32_bytes` does not trim. Anything crossing into the FFI must use `NO_WRAP`;
`DEFAULT` is correct only for KeystorePlugin's own at-rest IV/ciphertext format. Do not unify the
two.

Android has **two readers over the same alias and the same SharedPreferences**: `MlsDeviceKeyStore`
(background, Context-only) and `KeystorePlugin.getKeyBytes` (foreground, behind the BiometricPrompt).
The `NO_WRAP` fix landed on the first and was asserted only there, so the newline survived in the
second until v0.11.6. Its failure mode is the cruel one: the BiometricPrompt appears, the fingerprint
is *accepted*, the key decrypts - and then Rust rejects the string, `retrieve_device_key` returns
`None`, and `resolve_at_rest_key` reports "No keystore key" so the user is sent to the PIN modal.
Nothing in the log says the key was found, because from Rust's point of view it never was. Both
readers are covered now; the test captures the flag rather than matching the literal, so adding a
`DEFAULT` encode beside a `NO_WRAP` one still fails.

### Biometric mode must hand the key back to the frontend

`deviceKeyB64` seals two different things in two different layers. `mls.bin` is sealed in Rust,
which resolves the key itself; **local messages are AES-256-GCM blobs encrypted in the frontend**
(`db/sqlite.ts`, via `encryption.ts`). Biometric mode calls `init()` with an empty key on purpose -
that empty string is what selects `load_encrypted_with_keystore(pin: None)` - so Rust ends the login
holding the key and the WebView holding nothing.

That asymmetry made every biometric session lose its history writes. `importDeviceKey('')` rejects
(AES-GCM has no zero-length key), so **every stored row failed to decrypt and every new row failed
to be written**, and both persistence call sites swallow their error
(`saveMessages(...).catch(() => {})`). The visible half was a wall of `Failed to decrypt SQLite row`
on the second launch; the silent half was that nothing received during that session was ever saved.
The conversation *list* survived, which is what made it look cosmetic - conversation metadata rows
are plaintext.

`initialiser_mls` already caches the resolved key in `AppState.device_key`, so that saves arriving
later with an empty `device_key_b64` still work (`session_at_rest_key`). `recuperer_cle_session_mls`
returns that cached copy, and `loginImpl` pulls it into the session with `ctx.setDeviceKey` right
after `init()` succeeds and **before** anything reads `ctx.getDeviceKey()`. Reading the keystore
again instead would raise a second BiometricPrompt in the middle of a successful login;
`sessionDeviceKey.test.ts` pins the command to the cache for that reason.

Two invariants around it:

- The **local** `deviceKeyB64` in `loginImpl` stays empty. It means "a key the caller supplied", and
  it gates the device-key vault write and `store_push_context`. Biometric mode must keep both
  skipped - the keystore is where this key belongs at rest.
- A `null` answer **fails the login** (`LoginFailure('keystore_empty')` -> PIN modal) instead of
  continuing. Continuing is a whole session that persists nothing, with nothing in the log; the PIN
  path derives a working key and loses no data.

`TauriMlsService` also fills its own `_deviceKeyB64` from that answer, because
`reloadStateFromDisk` skips on a missing key - and skipping it on every resume is how a background
engine's advance to `mls.bin` gets clobbered by the next save (lost-update -> `SecretReuse`).

### A PIN change must never turn biometrics off

`applyNewDeviceKeyLocally` (`utils/chat/pinChange.ts`) is the tail of both the change and the
recovery flow, and it must **never** call `BiometricService.disable`. By the time it runs,
`IMlsService.changeDeviceKey` has already overwritten the keystore entry and `push_context.json`
with the NEW key, so disabling there deletes the entry that was just written and switches biometric
unlock off behind the user's back - a settings toggle silently flipped by an unrelated operation.
What it does instead is pick the destination: biometrics on -> keep the keystore authoritative and
`clearDeviceKeyAndWrapKey()` so the next launch still takes the biometric path rather than a silent
vault login; biometrics off -> `saveDeviceKey` into the local vault.

### An at-rest format change needs its own reader, in the same commit

Every at-rest envelope here is a byte layout with no version field: `mls.bin` is
`[nonce 12 || ciphertext]`, the keystore blob is KeystorePlugin's own IV/ciphertext pair, and the
SQLite rows are AES-256-GCM blobs. Nothing negotiates, so **a commit that changes one of those
layouts must ship the reader for the previous layout with it**. Shipping the writer first is not a
staged rollout: installed devices hold bytes in the old shape, the new reader rejects them, and the
failure surfaces as an unopenable state - which `classifyStateLoadFailure` reads as `sealed` or
`mismatch`, neither of which is what happened. The one-shot migrations already in the tree
(`CanariApplication.migrateDeviceKeyFromJson`, `CanariMigrateDeviceKeyFromJson`) are the shape this
takes: read the old, write the new, strip the old, all at the first start after the upgrade.

### The login guard cannot tell a caller's flag from a concurrent login

`loginImpl` refuses to run when `isLoginInProgress` is already set. `startLoginFlow` sets that same
flag before any `await`, for a different reason - `+layout.ts` must not fire `fetchUserProfile`
while a login is pending. Both read and write one variable, so **every entry point that calls into
`loginImpl` has to release the flag first**. The web branch and `nativeStorageLogin` did; the
biometric branch did not, and so the automatic biometric attempt of every cold launch was swallowed:

```
[BIOMETRIC] Biometric login attempt (keystore key path)...
[BIOMETRIC] Authenticating for userId=... via device keystore...
[LOGIN] Call ignored, a login already owns the flow (loggedIn=false, reconnecting=false, loginInProgress=true)
```

The sheet appeared, no OS prompt ever did, and the flow fell through to the PIN modal - where
tapping "use biometrics" worked, because the fall-through had cleared the flag on the way. That is
the whole "biometrics only work on the second try" report, and it is deterministic, not a race.
Re-entrancy is guarded separately by the component-local `_loginInProgress`, which is why releasing
the shared flag here is safe.

### When a state still refuses to open

The PIN modal's "forgot PIN" (`handlePinReset`) wipes the server-side and local MLS state and
restarts in first-setup mode. It costs the local history and is the last resort, after
`classifyStateLoadFailure` has ruled out a recoverable `sealed` state - see
[`protocols/mls-protocol.md`](../../protocols/mls-protocol.md).

### Erasing a revoked device, and the 1.25 s that undid it

`wipeRevokedDevice` (`session/sessionAuth.ts`) is the one consequence of one fact - this device is
revoked - reached from the three places that can learn it: the PIN check at login, the
`device_revoked` frame on a live session, and a vault or biometric login asking the server. Its
steps are ORDERED, and the order is the whole mechanism:

1. `tearDownLiveSession(ctx, cb, 'revoked')` - stop everything that is running.
2. `resetMls()` - destroy the MLS client.
3. `resetDeviceAsFreshImpl` - drop this user's MLS state, device id and local database.
4. `clearAuth()` - revoke the refresh credential, which needs the network context to still exist.
5. `wipeDeviceToFactory()` - every `CanariDB*` database, every cache, `localStorage.clear()`.
6. `setPin('')` - last, because the wipe is what makes the PIN meaningless.

**Step 1 did not exist until 2026-08-28, and its absence made steps 3 and 5 temporary.** Measured on
production to the millisecond: the server recorded the revocation at 08:40:39.773, the wipe ran, and
at 08:40:41.02 the SYNC_WATCHDOG - a 5 s interval nothing had stopped - found ten conversations still
in the live map and an empty WASM. It drove `requestReAdd` for all ten, which re-marked every group
in the `mls_not_ready_since` registry and, through `ensureMls()` (which builds a client whenever it
finds none), REBUILT the per-user MLS database. The device kept 8.2 MB of the install it had just
erased, and `[RESET] done - nothing of this device remains` was printed over the top of it.

`logoutImpl` had always done this teardown properly - four timers, the outbox, the offline-promotion
and peer-return listeners, the history probe sender, the conversation map that IS the watchdog's
candidate set. The revocation path had a comment claiming it did ("tear the session down first ... so
nothing left running can write a key back") and in fact only called `resetMls()`, which nulls a
reference and stops nothing. `tearDownLiveSession` is that teardown, shared, with `reason` as the
only discriminator: a revoked device does not FLUSH its MLS state on the way out (that write is what
the wipe exists to remove) and does not deregister a push token the server deleted when it revoked
the device.

`wipeDeviceToFactory` now also reads the stores back and NAMES whatever survived, because it had been
reporting the steps it ran as though they were the state of the disk. A second, delayed audit was
deliberately not added: the login page's "reset" button is the other caller, and a user who signs
back in writes keys within seconds, so a late check would accuse an ordinary new session of being a
zombie.

**A device revoked while OFFLINE is not wiped offline, by design.** Every login path asks the server
`isDeviceRevoked`, which answers `false` when it cannot be reached - a status code is an answer, a
transport failure is not - so the wipe happens at the first login WITH a network and never on a dead
link. One residue follows from the same fact: nobody is there to receive `notifyDeviceRevoked`, so
the device's `auth_sessions` row lives to its 7-day expiry.

## Mobile unlock flow (Tauri)

Driven by `startLoginFlow()` in `components/layout/ChatBackgroundService.svelte`.

**First sign-in** — OIDC, then the PIN sheet (with the "stay signed in" opt-in). Immediately after
the PIN is accepted, `BiometricEnrollSheet` offers biometric unlock, but only if the hardware is
available, biometrics are not already configured, and the offer was not previously declined. It
cannot be offered earlier: the device key does not exist until the first PIN entry. Declining is
permanent (`canari_biometric_prompt_dismissed` in `localStorage` **and** the native flag
`biometricPromptDismissed`, so it survives an Android process kill).

**Later sign-ins** — with biometrics enrolled, `BiometricBottomSheet` opens alongside the OS prompt.
On failure or cancellation there is no silent fallback: the PIN sheet opens, keeping the "use
fingerprint" button so the prompt can be retried (the button is hidden when no biometric is
usable). With a stored key and no biometrics, login is silent; the PIN sheet only appears if it
fails.

`BiometricBottomSheet` is rendered once and serves both flows; the enrolment variant is raised from
`enrollBiometricImpl` through the `biometricPrompt` store, so the post-login offer and the Settings
toggle behave identically.

### Two flags gate the biometric branch, and both must answer

`startLoginFlow` offers biometrics only when `BiometricService.isConfigured()` (the user opted in)
**and** `BiometricService.isKeyPresent(alias)` (a key really exists under
`mls_device_key_{userId}_{deviceId}`) both say yes. The second check exists so a reinstall - flag
restored from the native store, keystore empty - does not raise a prompt that could only fail.

A false answer from either is not a soft degradation: `biometricAttempted` stays false, the sheet
never opens, and `biometricConfigured = biometricAttempted` also hides the "use fingerprint" button
on the PIN modal. Biometrics become unreachable with nothing logged. That is precisely what
happened while `isKeyPresent` invoked a plugin that did not exist (see below), so it now logs its
failure instead of returning a bare `false`.

### The system biometric prompt

`BiometricService` raises it through `authenticate(reason, options)` from
`@tauri-apps/plugin-biometric`. Only `reason` is obvious from the signature, and it is **not** the
whole prompt - the plugin fills the rest from its own English defaults:

| Field | Passed by Canari | Plugin default if omitted | Shown on |
|---|---|---|---|
| `title` | `auth_biometric_prompt_{enable,disable}_title` | `"Fingerprint Authentication"` / `"Face Authentication"` (internal `biometryNameMap`) | Android |
| `subtitle` | *deliberately not passed* | none | Android |
| `reason` | `auth_biometric_desc` | none | Android (as description), iOS (`localizedReason`) |
| `cancelTitle` | `common_cancel_button` | `"Cancel"` | Android button, iOS `localizedCancelTitle` |

So a prompt whose `reason` is carefully localized still showed an English title and button. Shared
options live in `biometricPromptOptions()`; the title differs per call site.

**Passing every field the API accepts is not the same as filling the prompt well.** Android stacks
`title`, `subtitle` and description and then adds its own "touch the sensor" hint underneath, so
supplying all three put four lines on screen saying the same thing three ways. The `subtitle` was
dropped in v0.11.6: the title names the action, `reason` asks for the confirmation, and the OS names
the gesture. `reason` is also the *whole* prompt on iOS, so it has to stand alone - which is why it
is the generic `auth_biometric_desc` - a bare "confirm your identity to continue" - rather than a
restatement of the title, and why `auth_biometric_prompt_{enable,disable}` were deleted.

Wording across these strings names no modality. There is no Face ID on Android and no fingerprint on
a Face-ID-only iPhone, so a string offering "fingerprint or Face ID" was wrong on every device for
one half of its text; the catalogue now says "biometrics" and lets the OS prompt name the actual
sensor. The one exception is `auth_biometric_no_fingerprint_android`, Android-only by construction.

### The keystore unlock sheet is a second prompt, localized differently

The **keystore** plugin raises its own sheet, and only one command does: `get_key_bytes`, when
biometric mode reads the device key back. It runs in a native process with no access to the
Paraglide catalogue and no notion of the active locale, so its text cannot be resolved where it is
displayed - it travels down the call instead:

```
keystoreUnlockPrompt()            biometric.ts, the only place the strings are assembled
  -> invoke('initialiser_mls', { opts: { biometricPrompt } })
  -> InitMlsOptions              commands/mls.rs
  -> PluginDeviceKeyStore::with_prompt()
  -> GetKeyBytesRequest          flattened onto the wire: title/subtitle/cancelTitle/reason
  -> BiometricPrompt (Kotlin)  |  LAContext (Swift)
```

Every field is optional and each native side falls back to the French literal that shipped before
(`DEFAULT_UNLOCK_TITLE`, `kBiometricReason`, ...): a translation that fails to arrive must degrade
to the previous wording, never to an unlock that cannot happen. `reason` is iOS-only -
`BiometricPrompt` has no equivalent - and `title`/`subtitle` are Android-only. Four languages and
no compiler between them, so `services/keystorePrompt.test.ts` reads the Rust, Kotlin and Swift
sources and fails when a field is renamed or a literal creeps back into the builder.

The plugin used to carry a second, older API alongside this one - `store`/`retrieve`/`remove`, a
single secret under the hardcoded alias `unime_dev`, inherited from the UniMe sample it was forked
from. It had no caller in either the JS or the Rust layer and was deleted in v0.11.6, together with
the npm guest bindings (`@impierce/tauri-plugin-keystore`) that were its only published entry
point. The plugin now exposes exactly the four `*_key_bytes` commands.

### Calling the keystore plugin from JS

Two things must line up, and no compiler checks either:

| | Correct | Wrong, and silent |
|---|---|---|
| Prefix | `plugin:keystore\|…`, from `Builder::new("keystore")` | `plugin:app.tauri.keystore\|…` - that is the **Android class** id given to `register_android_plugin`, and resolves no plugin |
| Command | snake_case Rust fn name, e.g. `has_key_bytes` | the Kotlin/Swift method name, e.g. `hasKeyBytes` |
| ACL | listed in the plugin's `build.rs` COMMANDS **and** granted in `permissions/default.toml` | absent - the IPC boundary refuses the call although the Rust fn exists |

Build the identifier with `keystoreCommand()` from `services/keystoreCommands.ts` rather than
writing the string; `keystoreCommands.test.ts` reads the Rust sources and fails CI when a name,
the handler registration, the ACL array or the default permission set drift apart.

`has_key_bytes` never prompts: Android reads SharedPreferences only, iOS matches keychain
attributes without decrypting (it tests the background item first, which carries no access
control, then the primary one with `kSecUseAuthenticationUISkip`).

## Offline unlock

A cold start with no network used to be unable to open the app at all. The blocker was never the
PIN - it was `getToken()`. The access token lives in memory only, so every cold start goes to
`POST /api/auth/refresh`, and offline that `fetch` rejects before anything local is even read.
Meanwhile a complete encrypted history sits on the device, perfectly readable.

**Only the paths that already skip the server PIN check may unlock offline**
(`offlineCapable = isBiometric || isVaultLogin` in `sessionAuth.ts`). That is the whole security
argument, and it is not a convenience choice: on those two paths the platform keystore or the
encrypted device-key vault *is* the authentication factor, and no server answer is part of the
decision - online or offline. So an offline unlock verifies everything an online one verifies.
Nothing is skipped, and nothing is deferred.

The PIN path is deliberately excluded. Its at-rest key derives from a per-user salt only the server
holds (`GET /api/mls/security/pin-salt`), and that salt is never cached. Caching it is what would
turn a 4-character PIN into an offline-bruteforceable secret against `mls.bin`, so a PIN user with
no network still gets the honest `auth_server_unreachable`. `offlineUnlock.test.ts` pins this.

| Signal | Meaning | Offline unlock |
|---|---|---|
| `SessionExpiredError` (HTTP 401/403) | The server was reached **and refused us** | Never. Logs out. |
| Any other `getToken()` rejection | Transport failure - the server said nothing | Proceeds on the two capable paths |

That distinction is the rule the whole feature rests on: **a status code is an answer, a transport
failure is not**. `_doRefresh` separates them at the source, and `connectivity.svelte.ts` keeps the
two facts apart for everyone else (`navigator.onLine` is optimistic - a captive portal reports
`true` - so `isOffline` also requires that the last call actually reached the server).

An offline session sets `authToken = ''` and `isOfflineSession = true`, and login then skips the
gateway connect, the push registration, group discovery and **both watchdogs**. The watchdogs are
the harmful part: left running, the connection watchdog would schedule a reconnect every tick
against a network that is not there, and an offline session holds `authToken = ''`, so the handshake
has nothing to carry - **every attempt is known-futile before it is made**, which is the one case
where not retrying is the right answer. `promoteOfflineSession` starts all of it once a token
exists.

### The pause/resume pair, and why an asymmetric one goes quiet

`pauseConnectionImpl` stops the connection watchdog, the sync watchdog and any pending reconnect
timer on every background - correct on mobile, where the OS is about to freeze or kill the process.
The resume side has to give all of it back, and it did not: `resumeConnectionImpl` only attempted a
reconnect, and the mobile lifecycle handler in `ChatBackgroundService.svelte` did not even call it,
reaching for `attemptReconnect` directly. The watchdogs are armed exactly once, at login
(`sessionAuth.ts`) or on `promoteOfflineSession` - so **after a single background/foreground cycle a
phone had no timer left that could notice a dead socket.**

Measured on hardware 2026-08-10 (A1, prod): parked on `/chat` with the "En attente de connexion"
banner up, **zero reconnect attempts in ~20 minutes of logcat** while HTTP kept working throughout
(`[API] <- 200 GET /api/presence`), then `Reconnecting... -> [WS] Connected` **330 ms** after the
wifi was cut. The socket had been dead since some earlier outage on a guest network that let HTTPS
through; nothing in the client was still asking. The user's own report - "pourquoi est-on en attente
de connexion ?" - is what started the measurement.

`resumeConnectionImpl` is the single resume seam: it resets the backoff, re-arms both watchdogs
(both are idempotent) and only then reconnects if the socket is down - so it must run even when the
socket survived the background, which is why the `isWsConnected` guard moved out of the caller.
`ctx.timers.health` is cleared in two places and **started nowhere**: it is dead state, not a timer.

### WP-RECONNECT-1 - the ladder that stopped, and the two silences under it

**Fixed 2026-08-14. The above left a `reconnectCircuitOpen` latch in place, and it was the same
defect wearing a different hat.** After `MAX_RECONNECT_ATTEMPTS` (20) the ladder set the latch and
`scheduleReconnectImpl` refused every later call. Its own message named the release conditions -
retries pause *"until the app returns to the foreground or the network changes"* - and **a desktop
tab already in the foreground on an unchanged network emits neither event, ever.** So the release
condition was one an entire class of client cannot satisfy: termination from a clock, with a
resumption that is not universally reachable.

Captured on two production tabs, seven hours after a server outage, with `circuit.mjs`:

```
W1: {"online":true,"visibility":"visible","pill":"Hors-ligne","pageAgeMs":25772981}
W2: {"online":true,"visibility":"visible","pill":"Hors-ligne","pageAgeMs":25801936}

W1: CIRCUIT OPEN   watchdogTicks=2  retriesScheduled=0  socketsCreated=0
W2: CIRCUIT OPEN   watchdogTicks=2  retriesScheduled=0  socketsCreated=0
   [WS] Watchdog: socket inactive, reconnecting...     (x2, 60s apart, on each)
```

The watchdog was still firing and its request was discarded in silence - **the pair of lines is what
makes this a measurement rather than an inference**, since a watchdog tick with no
`Connection lost. Retrying in Ns...` after it can only be the early return at
`sessionConnection.ts:62`. Then the decisive experiment: a synthetic `visibilitychange` dispatched
into W1, *which was already visible*, reconnected it in under 20 s (`Reconnecting... -> [WS]
Connected`, pill `Connecté`, one socket) while W2 - untouched as a control - stayed dead. Nothing
about the network, the token or the server was wrong. Only the flag.

**The fix deletes the latch outright.** `reconnectCircuitOpen`, its two accessors and
`MAX_RECONNECT_ATTEMPTS` are gone; `reconnectAttempts` survives only as the index into
`RECONNECT_DELAYS`. Termination now comes from the two proofs that already existed:

| Terminator | Why it is a proof |
|---|---|
| `!ctx.isLoggedIn()` | There is no session to carry. |
| `SessionExpiredError` (401/403 on the refresh cookie) | The server was reached **and refused us** - an answer. Logs out, redirects to `/login`. |

A repeated transport failure is not an answer and may never end the loop. The cost that makes this
safe rather than merely correct: the backoff caps at 30 s, so a stuck tab settles at **two connect
attempts per minute** - the same order as the connection watchdog already ticking beside it, and far
below what the tab costs while connected. The two lifecycle events still land on
`resumeConnectionImpl`, but they now buy **latency, not recovery**: they reset the ladder to its 1 s
rung, so a client emitting neither still recovers on its own.

**Two further faults surfaced while fixing it, both silences:**

- `attemptReconnectImpl` called `scheduleReconnectImpl` from inside its `try`, where
  `isReconnecting` is still `true` - which is one of the two conditions on which
  `scheduleReconnectImpl` returns doing nothing. **Both failure paths were no-ops**, after logging
  `Retrying in Ns...`. The ladder never climbed itself; the 60 s watchdog was the real retry driver,
  which is why 20 attempts took twenty minutes rather than eight. The reschedule moved into the
  `finally`, after the flag is down.
- The same function nulled `ctx.timers.reconnect` without clearing it. When
  `resumeConnectionImpl` called it directly, the armed rung stayed armed, fired later, orphaned the
  rung scheduled in the meantime, and the two ladders climbed in parallel. Bounded before by the
  20-attempt latch; unbounded without it. It is now `clearTimeout`-ed.

`sessionConnection.test.ts` pins the mirror invariants: 40 rounds of the real fake clock with **no**
lifecycle event and no watchdog, asserting the ladder climbs past 20 by itself and that **exactly
one rung is armed at any moment** - unbounded in count must still be bounded in rate. Its fixture
was also completed (`getUserId`, `getDeviceKey`): without them `attemptReconnect` threw a
`TypeError`, the catch classified it as a transport failure, and every case measured a ladder driven
by the fixture's own incompleteness rather than by the connection outcome it was mocking.

**PROVEN ON A REAL CLIENT, 2026-08-15 (`ladder.mjs`, W2 against prod).** The fix is prospective, so
the original capture could not verify it - it measured a circuit that no longer exists, and a tab
reloaded to GET the fix has not lived through an outage. The proof therefore had to be MADE, and it
turns on one number: the old latch opened at 20, so **`attempt 21` is impossible under the old code
and inevitable under the new**. Held a real outage for 486 s (`armCut` + `cutHard` - offline first,
then the socket closed, since `emulateNetworkConditions` leaves an established WebSocket alone):

```
highest attempt    : 21          (old circuit opened at 20)
distinct delays    : 1, 2, 4, 8, 16, 30 s      attempts monotonic: true
watchdog lines     : 0
reconnected after  : 98 ms       (emulation lifted; NO synthetic online/visibilitychange)
```

**The zero is the second finding, and it was not predicted.** `startConnectionWatchdogImpl` returns
*before logging* when `ctx.timers.reconnect !== null`, so a silent watchdog means it found a rung
already armed on every one of its eight ticks. That is the outside view of the mirror invariant
`sessionConnection.test.ts` pins - exactly one rung armed at any moment - and it is direct evidence
that the ladder now climbs ITSELF: before the fix the watchdog was the only retry driver and left one
line per minute. The arithmetic agrees independently: 21 attempts on the `1,2,4,8,16,30…` ladder
predicts 511 s and 486 s were held, where a watchdog-driven client would have reached about 8.

Finally, `restore` only lifted the emulation - nothing dispatched the events the old circuit needed -
so the 98 ms recovery is the client's own.

### What happens on reconnect

`promoteOfflineSession.ts`, single-flight, subscribed to `connectivity.onReconnect`:

1. `getToken()`. Success sets the token and clears `isOfflineSession`. A `SessionExpiredError` means
   the session died while the device was away (expired, or revoked) - log out, keeping the local
   encrypted store, so signing back in restores the history. Any other failure leaves the session
   offline for the next attempt.
2. `startPushService` - re-registers rather than retries: FCM/APNs may have rotated the token.
3. `initializeConnection` - the same call login makes, so KeyPackages are published,
   `fetchPendingMessages` drains what the server queued, and groups reconcile under their own
   anti-purge guard.
4. **Then** `flushOutbox()`. The outbox has its own `online` listener that would otherwise fire
   before step 1, with an empty token: every queued entry would take a failed attempt and a longer
   backoff for a send that never had a chance. `canFlush: () => !ctx.isOfflineSession()` holds the
   queue until this point.
5. `historyRequestPendingStore.onResume()` and the watchdogs login skipped.

**Device revocation is not deferred by any of this.** `resetRequired` only ever arrives through
`pin-check`, which a biometric or vault login does not call *even when online* - so that gap
predates offline unlock, which merely widens the window before the next server contact notices it.
Revocation is still enforced on reconnect by the refresh answering 401 and by the gateway handshake.

### Login failure codes

`session/loginErrors.ts` defines `LoginFailure` with a machine-readable `LoginErrorCode`
(`pin_mismatch`, `state_sealed_with_old_key`, `keystore_empty`, `device_revoked`, `other`), passed
to `onLoginFailed(message, code)`. **Branch on the code, never on the message**: the message is
localized, so a regex over it silently stops matching in another locale - that is exactly how the
cross-device recovery link once became unreachable in French.
