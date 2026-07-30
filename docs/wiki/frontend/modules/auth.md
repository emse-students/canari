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

### When a state still refuses to open

The PIN modal's "forgot PIN" (`handlePinReset`) wipes the server-side and local MLS state and
restarts in first-setup mode. It costs the local history and is the last resort, after
`classifyStateLoadFailure` has ruled out a recoverable `sealed` state - see
[`protocols/mls-protocol.md`](../../protocols/mls-protocol.md).

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

### Login failure codes

`session/loginErrors.ts` defines `LoginFailure` with a machine-readable `LoginErrorCode`
(`pin_mismatch`, `state_sealed_with_old_key`, `keystore_empty`, `device_revoked`, `other`), passed
to `onLoginFailed(message, code)`. **Branch on the code, never on the message**: the message is
localized, so a regex over it silently stops matching in another locale - that is exactly how the
cross-device recovery link once became unreachable in French.
