# Canari - Agent Delegation Timeline

This file is the **delegation log**: work handed to autonomous agents (Zoo Code, Aider, background
Claude sessions), and the verification verdict once it came back.

It is a **separate timeline** from `CLAUDE.md`. Do not duplicate SESSION STATE here.

- `CLAUDE.md` -> project rules + canonical SESSION STATE (what the project needs next).
- `AGENTS.md` (this file) -> who did what, when, and whether it survived verification.

## Rules

1. **Nothing delegated is trusted until verified.** An agent reporting "done" is a claim, not a fact.
   Every entry below carries a verdict from a re-run of the gates, not from the agent's own summary.
2. **One entry per delegated batch.** Record: date, agent, scope, verdict, and any defect the
   verification pass found. Keep defects even after fixing them - they are the reason this file exists.
3. **Record the detection recipe, not just the result.** A sweep that used the wrong regex will be
   repeated by the next agent unless the gap is written down (see 2026-07-27).
4. **Gates before any verdict:** `bun run check` / `lint` / `format`, `bun run test`, per-app
   `npm run lint` / `format:check` / `test`, `cargo clippy --all-targets -- -D warnings`.
5. Prune entries once the lesson is folded into `CLAUDE.md` gotchas.

---

## Pending delegation brief - WP-SEC-1 (device key out of cleartext)

Not started. Written 2026-07-28 against `e14b36f0`. Line numbers are anchors at that commit -
re-locate by symbol name, never by line. Move this section into the Timeline with a verdict once
it has been executed AND checked on hardware.

**Ship as TWO commits, in this order.** Part A is a live P1 bug that is not part of WP-SEC-1; it
must land and be checked on a device BEFORE part B, because B rewrites the same read path and
would make an A-failure indistinguishable from a B-failure.

### Part A - the iOS background decrypt path has been dead since v0.11.0

`ios_ffi.rs` names the parameter `device_key_b64` (L60, L104, L145) and `store_push_context`
writes the JSON key `deviceKeyB64` (`push.rs` L344). The whole Objective-C / Swift side still
calls it `pin` and still parses `json["pin"]`, which nothing has written since v0.11.0. So
`CanariLoadPushContext` returns nil on **every** call: the NSE serves the generic fallback for
every push, and quick reply, mark-read, welcome-request and the outbox drain all abort at
"push_context absent". Android is unaffected - `MlsContextLoader.kt` L57 reads `deviceKeyB64`.

Same class of defect as the Lot 2 entry below: a rename that the compiler cannot see because the
contract is a string.

`frontend/src-tauri/gen/apple/Sources/canari/canari_push.mm`

- L55 `@property(nonatomic, copy) NSString *pin;` -> `NSString *deviceKeyB64;`
- L240 `dict[@"pin"]` -> `dict[@"deviceKeyB64"]`
- L244 remove the key from the required-fields guard -> `if (userId.length == 0 || deviceId.length == 0 || baseUrl.length == 0) return nil;`
- L248 `ctx.pin = pin;` -> `ctx.deviceKeyB64 = deviceKeyB64;`
- Call sites passing `ctx.pin.UTF8String`: L479, L538, L581, L1273, L1579, L1664. Each must now
  bail early when `ctx.deviceKeyB64.length == 0`, mirroring `CanariFirebaseMessagingService.kt`
  L1712 / L1839 (`?: return null`).

`frontend/src-tauri/gen/apple/canari_NSE/NotificationService.swift`

- L466 `let pin: String` -> `let deviceKeyB64: String`; L486 `json["pin"]`; L490 guard; L491 ctor
- Call sites L234, L254, L276, same non-empty guard.

Keeping the key OUT of the required-fields guard is deliberate: it makes Part A forward-compatible
with Part B, where the key stops coming from the JSON entirely.

**Regression guard to add in the same commit.** The only reason this survived is that no test
compares the JSON keys `store_push_context` writes against the keys the three native readers
parse. Add a node test that greps `canari_push.mm`, `NotificationService.swift` and
`MlsContextLoader.kt` for the push-context field names and fails on a mismatch - same shape as
the existing `src/lib/mobile/androidFcmManifest.test.ts` manifest guard.

### Part B - WP-SEC-1 proper

**B0. What is actually exposed.** The 32-byte key sits in cleartext in up to three places today:
`{app_data_dir}/push_context.json` on both platforms; on iOS also the App Group mirror
`group.fr.emse.canari/push_context.json` (`canari_push.mm` `CanariMirrorPushStateToAppGroup`
L283). Android already sets `allowBackup="false"` (`AndroidManifest.xml` L55), so it cannot leave
the device through adb backup. The iOS app container IS included in unencrypted Finder/iTunes
backups - that is the realistic exfiltration path and the reason this is P1.

**B1. Two corrections to the WP text in `CLAUDE.md` - it is wrong as written.**

- **Do NOT set `setUnlockedDeviceRequired(true)` on Android.** It makes the key unusable while the
  screen is locked, which is exactly when a push arrives. The Android analogue of iOS
  `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` is credential-protected storage with no
  unlocked-device requirement, i.e. what the plugin already generates.
- **Android needs no new keystore slot.** `KeystorePlugin.generateBiometricProtectedKeyForAlias`
  (`KeystorePlugin.kt` L448-467) already builds the alias with `setUserAuthenticationRequired(false)`;
  the key is background-usable today. The only blocker is that `getKeyBytes` (L337) needs an
  Activity for its BiometricPrompt *UX* gate. The work is a Context-only reader, not a new key.
- iOS genuinely does need a new keychain item: the existing one (`KeystorePlugin.swift` L156-166)
  is `.userPresence` + `WhenUnlockedThisDeviceOnly` with no access group, so the NSE can neither
  see it nor satisfy it.

**B2. Android.** New file
`frontend/src-tauri/gen/android/app/src/main/java/fr/emse/canari/MlsDeviceKeyStore.kt`, modelled
on `PushSecretKeystore.kt`:

```kotlin
object MlsDeviceKeyStore {
    private const val PREFS_NAME = "keystore_aliases"   // MUST match KeystorePlugin.kt
    fun alias(userId: String, deviceId: String) = "mls_device_key_${userId}_${deviceId}"
    fun retrieve(context: Context, userId: String, deviceId: String): String?   // base64, null if absent
    fun store(context: Context, userId: String, deviceId: String, keyB64: String): Boolean
}
```

The read path must reproduce `KeystorePlugin.readCipherDataForAlias` + `getDecryptionCipherForAlias`
exactly: prefs name `"keystore_aliases"`, keys `"${alias}_iv"` / `"${alias}_ct"`, `AES/GCM/NoPadding`,
`GCMParameterSpec(128, iv)`, key via `KeyStore.getInstance("AndroidKeyStore").getKey(alias, null)`.

- **Decode with `Base64.DEFAULT`, not `Base64.NO_WRAP`.** The plugin encoded with `DEFAULT`
  (`KeystorePlugin.kt` L503-507), which inserts newlines. `PushSecretKeystore` uses `NO_WRAP`, so
  copying it verbatim corrupts the ciphertext. This is the easiest way to get this silently wrong.
- Do NOT use `createDeviceProtectedStorageContext()` - credential-protected storage is the correct
  one (readable after first unlock) and the prefs do not exist in direct-boot storage.

Then `MlsContextLoader.loadPushContext` (`MlsContextLoader.kt` L45): stop reading `deviceKeyB64`
from the JSON, source it from `MlsDeviceKeyStore.retrieve(...)`. Keep the `deviceKeyB64: String = ""`
default and keep it out of the null guard so existing callers keep their behaviour. Nothing else on
Android changes - every background caller already funnels through `MlsContextLoader`.

**B3. iOS.**

1. Entitlements - add to BOTH `canari_iOS/canari_iOS.entitlements` and
   `canari_NSE/canari_NSE.entitlements`:

   ```xml
   <key>keychain-access-groups</key>
   <array>
     <string>$(AppIdentifierPrefix)group.fr.emse.canari</string>
   </array>
   ```

   This needs Keychain Sharing on the App ID and **regenerated provisioning profiles for both
   targets** (`Canari` and `CanariNotifications`, team 4CLNB8SR6L). Codesign otherwise fails with
   "profile doesn't include the ... entitlement" - the same trap the time-sensitive entitlement
   comment already records in `canari_iOS.entitlements`.

2. `KeystorePlugin.swift` `storeKeyBytes` (L147): after the existing `.userPresence` item, write a
   SECOND item:

   ```
   kSecClass           = kSecClassGenericPassword
   kSecAttrService     = "fr.emse.canari"
   kSecAttrAccount     = "mls_bg_key_\(alias)"        // distinct from "mls_key_\(alias)"
   kSecAttrAccessGroup = "group.fr.emse.canari"
   kSecAttrAccessible  = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
   // NO kSecAttrAccessControl - that is exactly what locks the NSE out today
   ```

   `SecItemDelete` the same query first or `SecItemAdd` returns `errSecDuplicateItem`. Mirror the
   deletion in `deleteKeyBytes` (L228) so revoking a device clears both items. Attribute precedent:
   `canari_push.mm` `CanariPushSecretStore` L166-181 already writes an
   `AfterFirstUnlockThisDeviceOnly` generic password.

3. Readers: add `CanariRetrieveDeviceKey(userId, deviceId)` next to `CanariRetrievePushSecret`
   (`canari_push.mm` L183) and its Swift twin in `NotificationService.swift`. Wire both into the
   struct returned by `CanariLoadPushContext` / `loadPushContext`, replacing the JSON field.
   **Ordering constraint:** the account name needs userId + deviceId, which come from the JSON -
   parse the JSON first, then hit the keychain.

4. `CanariMirrorPushStateToAppGroup` (L267) needs no code change, but once the field is gone the
   mirrored copy stops carrying the key. Delete any stale mirrored copy once at startup (B5).

**B4. Rust.**

- `push.rs` `store_push_context` (L315): drop `"deviceKeyB64"` from the JSON literal (L344). Keep
  the keystore write (L331-335) but make it **fatal** - with no JSON copy left, a silently failed
  keystore write means background decrypt is dead with no signal. Return `Err`, do not `log::warn!`.
- `push.rs` `clear_push_context_key` (L353): the field no longer exists. Either delete the command
  along with its `lib.rs` L813 registration and every TS `invoke`, or repoint it at
  `delete_device_key`. Grep both sides - Tauri command names are unchecked strings.
- `push.rs` `check_push_secret_health` (L28-41): stop probing the JSON field, probe the keystore via
  `PluginDeviceKeyStore::retrieve_device_key`. **On iOS it must probe the new background item, not
  the `.userPresence` one, or the health check raises a Face ID prompt at every startup.**

**B5. Migration - mandatory, same commit.** (Durable rule: an at-rest format change needs a reader
for the previous format in the SAME commit.) Existing installs hold the key only in
`push_context.json` until the user's next login or PIN change. Do a ONE-SHOT promotion in the **app**
process at startup - never a permanent read fallback in the background readers:

- Android: in `CanariApplication`, next to `processPendingPushSecret` (it already opens
  `push_context.json` at L49). If the JSON still carries a non-empty `deviceKeyB64`, store it via
  `MlsDeviceKeyStore`, then rewrite the JSON without the field.
- iOS: same in `canari_ios.mm` where `CanariMirrorPushStateToAppGroup` is already called (L80/L89).
  Promote to the keychain, strip the field, re-mirror, and delete the stale App Group copy.

`MlsContextLoader` and the NSE must not read the JSON key at all. If the app has not run since the
update, one push falls back to the generic text and the next launch fixes it permanently. That is
the acceptable cost; a permanent fallback is not.

**B6. Gates.**

- `cd frontend/src-tauri && cargo clippy --all-targets -- -D warnings` + `cargo test`
- Kotlin: `cd frontend/src-tauri/gen/android && ./gradlew :app:compileUniversalReleaseKotlin` - the
  only real Kotlin compile, debug variants do not catch it.
- Swift / Objective-C: no compile is available off macOS. This half is unverifiable locally and
  must not be believed before TestFlight.
- `bun run check` / `lint` / `format` if any TS moved.

**B7. Device checks that gate the verdict.** Nothing below is proven without them.

1. Android, app killed, screen locked: an incoming DM shows decrypted text.
2. iOS, app killed, screen locked: same. This is also the first ever proof of Part A.
3. Both: change the PIN, then repeat 1-2 (`store_push_context` rewrote the same alias).
4. Both: fresh install + login, then repeat 1-2.
5. Upgrade path: install the CURRENT store build, log in, install the new build over it WITHOUT
   logging in again, launch once, kill, then repeat 1-2. This is the only test of B5.

**B8. Traps.**

- An empty `deviceKeyB64` must never be conflated with "no context". Android already separates them;
  Part A makes iOS match.
- `applyNewDeviceKeyLocally` must still never call `BiometricService.disable` - the alias it deletes
  is the one the background reader now depends on.
- The Android alias `unime_dev` (`KeystorePlugin.kt` L26) is a different, biometric-gated key. Do
  not touch it - renaming orphans enrolled keys.
- Do NOT add `.setKeySize(256)` to `generateBiometricProtectedKeyForAlias` in this commit. It only
  affects newly created aliases, so it would split behaviour between fresh and upgraded installs
  while the migration is being validated. Worth doing, separately.

---

## Timeline

### 2026-07-27 - Post-v0.11.0 remediation, batch 2 (Lot 4 remainder + Lot 5 + T16)

**Delegated:** T11 remainder (French comments), T16 (`pin` -> `deviceKeyB64` rename), Lot 5 (CHANGELOG,
delete `plans/` + `docs/strategy/`), B1 (fr/en key parity).

**Verdict: accepted with corrections.** The work was real and largely correct, but shipped with a
broken test, unformatted files, and an incomplete sweep. Corrections applied in the verification pass:

| # | Defect found in verification | Fix |
|---|---|---|
| 1 | `setupMessageHandler.test.ts` still built deps with `pin:` after the T16 rename -> production read `deps.deviceKeyB64` and got `undefined`. **Test suite was red.** | Renamed the fixture key; 5 stale fixtures total (`setupMessageHandler`, `systemMessageHandler.exclusion`, `systemMessageHandler.readReceipt`, `outbox`, `recovery`). |
| 2 | **T11 swept only `//` line comments.** JSDoc/rustdoc block comments (`/** ... */`) were never searched - ~250 French lines across 67 files remained, including files French end to end (`epochGapRegistry.ts`, `mlsDecryptError.ts`, `groupLifecycle.ts`). | Full block-comment sweep; all translated. |
| 3 | Two frontend files left unformatted (`oxfmt` not run). | `bun run format`. |
| 4 | T7 only translated the `[Unreleased]` block; the version sections it was supposed to cut were never created. | Cut `[Unreleased]` into v0.10.10 - v0.11.0 sections, attributed from tag ranges. |
| 5 | `SECURITY.md` entry sat under `[Unreleased]` although it shipped in v0.1.0 (2026-03-08). | Moved to the v0.10.9 catch-all section. |

**Detection recipes** (ripgrep; use the `-i` **flag**, never inline `(?i)` - it fails to parse):

- Line comments: `//.*\b(le|la|les|une|des|dans|pour|avec|sur|est|sont|pas|que|qui|cette|cle|clé|chiffr|dechiffr|déchiffr|utilise|permet|renvoie|retourne|evite|évite|verifie|vérifie|charge|stocke|recupere|récupère|supprime|ajoute|lors|ainsi|afin|depuis|aucun|chaque|meme|même)\b`
- **Block comments (the half that was missed):** `^\s*(\*|/\*\*).*\b(le|la|les|une|des|dans|pour|avec|sur|est|sont|pas|que|qui|cette|clé|chiffr|déchiffr|utilise|permet|renvoie|retourne|évite|vérifie|stocke|récupère|supprime|lors|ainsi|afin|aucun|chaque|même|injecte|identifiant|valide|filtre)\b`
- Rust: same pattern with `^\s*(///|//!|\*)`.
- Known false positives: `Carte de la Vie Asso`, `double-charge`, `charge-saved-method`,
  `Destination charge`, `Avec alcool`, `Rejoindre la communauté` (quoted UI strings),
  `Maison des eleves`, `Le Cercle`.

**Gates after correction:** svelte-check 0 errors / 0 warnings / 7320 files - frontend 565/565 -
social-service 124/124 - chat-delivery 70/70 - oxlint + oxfmt clean on all three - clippy clean on
chat-gateway. `fr.json` / `en.json` both 2165 keys, zero orphans either way.

**Unrelated pre-existing issue fixed in passing:** `apps/social-service` had 19 files failing
`oxfmt --check` on `HEAD` (double-quoted strings never formatted). Fixed; tests still 124/124.

---

### 2026-07-27 - Post-v0.11.0 remediation, batch 1 (Lots 1-3, interactive)

Done in-session, not delegated. Summarized in `CLAUDE.md` SESSION STATE. Two findings worth keeping
here because they show the failure mode this file guards against:

- **Lot 2:** `store_push_context` declared a `pin` parameter while all three call sites passed
  `deviceKeyB64` -> the invoke failed on a missing argument *every time*, silently swallowed by
  `.catch(() => {})`. A naming lie that shipped and stayed invisible.
- **Lot 3:** the audit claimed prod migrations were hand-applied. They were not. The real defect was
  the absence of a ledger, so one-shot backfills replayed on every deploy.

---

## Open device checks (cannot be verified from a dev machine)

- [ ] Decrypted push notification on Android **and** iOS (Lot 1 - the whole point of the fix).
- [ ] Login, PIN change, biometric enable/disable on a real device (Lot 2).
- [ ] v0.11.1 auth fixes: PIN change must KEEP biometrics enabled (was silently disabling them);
      the fingerprint button must stay on the PIN sheet after a cancelled biometric prompt;
      the enrolment bottom sheet must appear right after the first PIN entry, once only.
