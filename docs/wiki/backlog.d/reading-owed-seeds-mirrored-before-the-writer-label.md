## Reading owed - seeds mirrored before the writer label

target: 1.7.0

**What is built:** seeds mirrored before the writer label (2026-11-07) outlive a wiped account only on an install another account shares ([auth](../frontend/modules/auth.md#the-seed-mirror-labels-each-entry-with-its-writers-2026-11-07))

**The reading that closes it:** on a phone that ran a pre-label build, one wipe whose page line says `alone on the install: false`: its `[GRAINE_MIRROR]` line reads `0 of unknown writer left` ([procedure](../device-verification.md#the-seed-mirror-labelled-by-account---owed-2026-11-07)); a count that stays above 0 long after the label shipped is what would call for a build

**Triage 2026-11-14: Mi 9T, bench build, about 30 min** (install a release APK from before the label, `v1.6.6`, log in as the bench account and one more on the install, then update to the current build and wipe).

**Mi 9T, 2026-11-16: NOT STAGED.** A pre-label build the server still accepts exists (`v1.6.6` is the floor and was cut before the label commit of 2026-11-07 16:35 UTC; `v1.6.7-alpha.1` too), but putting it on the phone means an uninstall (the same signing key allows the update upward only), then two accounts enrolled on the install with identity-provider sign-ins, then the update and the wipe. Not done in this sitting; unchanged, about 30 min.

**Mi 9T, 2026-11-16 (uninstall sitting, [section](../device-verification.md#the-mi-9t-readings-of-2026-11-16-the-uninstall-sitting-170-alpha5-the-seed-mirrors-wipe-and-the-envoyer-a-rows)): the wipe half read, `PARTIAL`.** The phone was reinstalled on `v1.6.7-alpha.1` (before the label), `beta` took its first sync (ten unlabelled seeds), the build was updated to `v1.7.0-alpha.5` and `beta`'s device removed from its web seat: page line `0 seed entry(ies) removed ... (alone on the install: false)`, Rust's `0 removed, 0 kept for another writer, 0 of unknown writer removed, 25 of unknown writer left`. The step that matters (a wipe with another account on the install removes no entry of unknown writer) holds. **The closing sentence above says `0 of unknown writer left`, which contradicts procedure step 3 (`K of unknown writer left`) and is only true after the install's LAST account is wiped (step 5)**; read it as step 5's outcome. Left: step 5 (a throwaway account alone on an install updated over a pre-label build; the Mi now carries `alpha` and the parked `beta`), and the push-writer steps 2 and 4 (no push token on a bench build).
