## Reading owed - seeds mirrored before the writer label

target: 1.7.0

**What is built:** seeds mirrored before the writer label (2026-11-07) outlive a wiped account only on an install another account shares ([auth](../frontend/modules/auth.md#the-seed-mirror-labels-each-entry-with-its-writers-2026-11-07))

**The reading that closes it:** on a phone that ran a pre-label build, one wipe whose page line says `alone on the install: false`: its `[GRAINE_MIRROR]` line reads `0 of unknown writer left` ([procedure](../device-verification.md#the-seed-mirror-labelled-by-account---owed-2026-11-07)); a count that stays above 0 long after the label shipped is what would call for a build

**Triage 2026-11-14: Mi 9T, bench build, about 30 min** (install a release APK from before the label, `v1.6.6`, log in as the bench account and one more on the install, then update to the current build and wipe).

**Mi 9T, 2026-11-16: NOT STAGED.** A pre-label build the server still accepts exists (`v1.6.6` is the floor and was cut before the label commit of 2026-11-07 16:35 UTC; `v1.6.7-alpha.1` too), but putting it on the phone means an uninstall (the same signing key allows the update upward only), then two accounts enrolled on the install with identity-provider sign-ins, then the update and the wipe. Not done in this sitting; unchanged, about 30 min. The uninstall is allowed on the bench phones ([owner, 2026-11-16](owner-decisions-of-2026-11-16.md)).

**Mi 9T, 2026-11-16 (`1.7.0-alpha.5`): NOT TAKEN, and what is left.** The push-writer steps (2, 4 and 6's push half) are DELETED by the owner's decision (20) ((deleted 2026-11-16 by the owner's decision (20): not stageable on the bench)); the only reading left is step 5, which needs a throwaway test account deleted from Settings on a phone holding that account alone, over a pre-label build. The bench has no throwaway account (each of the four is in use and a fifth needs an identity-provider sign-in), and deleting `alpha` is irreversible, so it was not done.
