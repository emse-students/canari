## P3 - A cancelled biometric sheet is logged as `keystore_empty`, a key that is not there (owner's Android log, 2026-11-25)

target: 1.8.3

Read in the owner's Android log (1.8.0): a biometric login raised its sheet, failed seven seconds later
with `[INIT] Login did not complete (keystore_empty)`, and the PIN login of the SAME session read the
hardware-held key from the keystore 35 s after (`[AT_REST_KEY] hardware-held key read from the
keystore`). The key was there; the sheet was dismissed or failed. The line names the wrong cause, and a
reader looking for a wiped keystore is sent the wrong way. (The duplicate plain line beside the W one
was removed on 2026-11-25; this entry is the label.)

**Why it is not fixed at the page.** The distinction is lost before the page ever sees it, so it cannot
be classified at the throw that `sessionAuth.ts` makes:

- Android: the keystore plugin (`src-tauri/patches/tauri-plugin-keystore/android/.../KeystorePlugin.kt`)
  rejects `onAuthenticationError` with `"Authentication error: $errorCode"` - the BiometricPrompt code
  (user cancel, negative button, lockout) travels only inside a sentence.
- iOS: `KeystorePlugin.swift` answers `null` for both "not found" and "user cancelled".
- Rust: `PluginDeviceKeyStore::retrieve_device_key` (`src-tauri/src/keystore_bridge.rs`) returns an
  `Option`, logging the refusal at info, and `mls-core`'s `resolve_at_rest_key` turns every `None` into
  `MlsError::KeystoreKeyUnavailable`, which the page types as `KeystoreKeyUnavailableError` and
  `sessionAuth.ts` turns into `LoginFailure('keystore_empty')`.

**What closes it.** The plugin rejects a dismissed sheet with a typed code on both platforms
(Android: `BiometricPrompt.ERROR_USER_CANCELED` / `ERROR_NEGATIVE_BUTTON` / `ERROR_CANCELED`; iOS:
`LAError.userCancel` / `.systemCancel` / `.appCancel` distinguished from `errSecItemNotFound`), the
`DeviceKeyStore` trait answers `Result<Option<key>, KeyReadRefusal>`, `MlsError` carries a
`KEYSTORE_PROMPT_DISMISSED` code across the boundary beside `KEYSTORE_KEY_UNAVAILABLE`, and the login
throws `LoginFailure('biometric_dismissed')` (an expected outcome, same keypad). A native change on both
platforms, so it needs the native review and a reading on both phones: dismiss the sheet, read the
reason in the in-app log. Mechanism: [auth](../frontend/modules/auth.md).
