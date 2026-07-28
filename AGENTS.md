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

## Timeline

### 2026-07-28 - WP-IOS-1 + WP-SEC-1 (device key out of cleartext), delegated

**Agent**: Zoo Code mode, from the brief this file carried.
**Scope**: the dead iOS `pin` read path, then the move of the device key into the platform
keystores - Android `MlsDeviceKeyStore.kt` (Context-only reader) + `MlsContextLoader.kt` +
`CanariApplication.kt`, iOS `KeystorePlugin.swift` (second background item) + `canari_push.mm` +
`NotificationService.swift` + `canari_ios.mm` + both entitlements, Rust `push.rs`, one-shot
migration on both platforms.

**Verdict: accepted with corrections.** The design is right and the hard parts are right - the
Context-only Android reader mirrors the plugin's scheme exactly, the iOS background item avoids
`kSecAttrAccessControl`, and the one-shot migration lands on both platforms including the App Group
mirror deletion. Four defects were found in the verification pass and fixed before commit:

1. **Its own new test failed, 4 of 6.** Part A added `pushContextFields.test.ts` asserting all four
   sides carry `deviceKeyB64`; Part B then removed that field from the JSON and never re-ran it.
   The Part B gate list in the agent's report shows `cargo`, `gradlew` and `bun run check` - `bun
   run test` is simply absent. Rewritten against the real post-B contract (the JSON carries no key
   material; each reader must source the key from its keystore; both migrations must still exist),
   now 16/16.
2. **Android background decrypt would have failed on every push.** `MlsDeviceKeyStore.retrieve`
   returned `Base64.encodeToString(decrypted, Base64.DEFAULT)`, and `DEFAULT` terminates its output
   with a newline. That string is handed to the Rust FFI, whose `decode_base64_to_32_bytes` does
   **not** trim, so the STANDARD engine rejects the whole value. The exact trap the brief flagged,
   inverted: `DEFAULT` is correct for the IV/CT (KeystorePlugin's at-rest format) but wrong for the
   wire value. Now `NO_WRAP`, with the reason in a comment.
3. **`clear_push_context_key` was left as a no-op that returns `Ok(())`.** The brief offered delete
   or repoint; the agent chose neither and stubbed it, leaving a registered Tauri command that
   silently claims success while doing nothing. Deleted, with its `lib.rs` import and registration.
4. **No CHANGELOG entry and no wiki update**, both mandated by `CLAUDE.md`. Added, including the
   `push_context.json` contents in `frontend/mobile.md` and the "Where the key lives" table in
   `frontend/modules/auth.md`.

Two more defects surfaced the moment CI actually compiled the iOS half (`gh workflow run
ios-release.yml`, which only builds and uploads artifacts - every publish step is gated on
`workflow_run`). Both were invisible to every gate available on Windows:

5. **`KeystorePlugin.swift` did not compile.** `guard bgStatus == errSecSuccess else { NSLog(...) }`
   - a `guard` body must not fall through. The Rust prebuild died there, so nothing downstream
   (NSE, ObjC, archive) was ever compiled either. Rewritten to throw, like the primary item above
   it: the NSE has no JSON fallback left, so a skipped background item means every push shows
   generic text with nothing in the log to say why, and the only known cause (an access group
   missing from the profile) fails at codesign rather than here.
6. **The key was stored raw and read as UTF-8 - iOS background decrypt would have failed 100% of
   the time.** `storeKeyBytes` base64-DECODES its argument and writes the raw 32 bytes (that is why
   `getKeyBytes` base64-encodes on the way back out), but both new background readers ended with
   `String(data:encoding:.utf8)` / `initWithData:encoding:NSUTF8StringEncoding`. Random key bytes
   are almost never valid UTF-8, so the reader returned nil, the key came back empty and the guard
   added in Part A turned every push into the generic fallback. The iOS *migration* had the mirror
   error, writing the base64 TEXT, so a migrated install would also have disagreed with a
   freshly-logged-in one. This is the same class as defect 2 and Android was right both times.
   `pushContextFields.test.ts` gained a second describe block asserting the encoding contract
   across all five files - the only gate for it off macOS.

Also corrected: three Swift `var`s that are never mutated and two deprecated
`kSecUseOperationPrompt` uses (the reason already travels on the `LAContext`), all of them warnings
in the CI log; `MlsDeviceKeyStore.delete` was dead code (`KeystorePlugin.deleteKeyBytes` already
owns deletion on the same alias and prefs), and the AGENTS.md link to `KeystorePlugin.swift`
pointed at `gen/apple/` instead of `patches/tauri-plugin-keystore/ios/`.

One accepted deviation: B4 asked `check_push_secret_health` to probe the keystore rather than the
JSON field; the agent removed the probe instead. That is the safer call - the Rust accessor routes
through the plugin's `getKeyBytes`, which on iOS hits the `.userPresence` item and would raise a
Face ID prompt at every startup. The `keystore_ok.flag` it now trusts alone probes the push secret,
not the device key, but keystore loss takes both down together. Comment corrected to say so.

**Gates re-run after the corrections:** `cargo clippy --all-targets -- -D warnings` clean,
`bun run test` 607/607 including 25 on the rewritten guard, `bun run check` 0/0. **Android Release
green on CI**; iOS Release dispatched too - it is the only way to compile Swift/ObjC from here, and
it is what found defect 5. Compiling is still not running: everything below is owed.

**Rule 6, learned here: dispatch `android-release.yml` and `ios-release.yml` before believing any
native change.** Both take `workflow_dispatch` and gate every publish step (GitHub Release, Google
Play, TestFlight) on `workflow_run`, so a manual run is a pure compile check that ships nothing.
Without it, a Swift syntax error passes every gate this machine has.

**Still owed: every device check below. Nothing here is proven without them** - and check 2 is also
the first ever proof that iOS background decrypt works at all.

---

## WP-SEC-1 / WP-IOS-1 - what is still owed

Implementation shipped 2026-07-28. The steps are in the commit; only the unverified part is kept
here (rule 5). Durable rules folded into `CLAUDE.md`.


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
- Do NOT add `.setKeySize(256)` to `generateBiometricProtectedKeyForAlias` yet. It only affects
  newly created aliases, so it would split behaviour between fresh and upgraded installs while the
  migration is still unvalidated. Worth doing once the device checks above pass.
- `MlsDeviceKeyStore` encodes the IV/CT with `Base64.DEFAULT` because that is KeystorePlugin's
  at-rest format, but the key it RETURNS with `Base64.NO_WRAP` - `DEFAULT` appends a newline and
  the Rust `decode_base64_to_32_bytes` does not trim. Do not "unify" the two.
- **The key sits in the keystore as RAW 32 bytes and crosses the FFI as base64.** Writers decode
  before storing, readers encode after loading, on both platforms and in both migrations. Treating
  the stored bytes as text (UTF-8) or storing the base64 text instead silently yields no key.

---
