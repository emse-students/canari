## P3 - Reading owed: a dismissed biometric sheet is logged as `biometric_dismissed`, on both phones (1.8.3)

target: 1.8.3

The plugins (Kotlin `KeystorePlugin.kt`, Swift `KeystorePlugin.swift`) now reject a dismissed sheet with the code `PROMPT_DISMISSED`, read in `keystore_bridge.rs`; compiled and unit-tested only ([auth](../frontend/modules/auth.md)). Reading on the Mi 9T and the iPhone 12: raise the biometric sheet at launch and dismiss it (cancel / the negative button; on iOS cancel Face ID). The in-app log must carry `[INIT] Login did not complete (biometric_dismissed)` and `[KEYSTORE] the biometric sheet was dismissed`, NOT `keystore_empty`, and the PIN keypad must show. A wrong finger (non-final attempt) is unchanged. Also confirm the Swift `invoke.reject(_, code:)` call compiles in the iOS build.
