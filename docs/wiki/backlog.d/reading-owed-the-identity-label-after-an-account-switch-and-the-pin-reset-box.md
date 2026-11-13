## Reading owed - the identity label after an account switch and the PIN reset box

target: 1.7.0

**What is built:** the identity label after an account switch and the PIN reset box (#1604)

**The reading that closes it:** ANSWERED for the same account on 2026-10-13: a skipped unlock on a key the live process still held, NOT the vault (a cold relaunch asked for the PIN, [readings](../device-verification.md#the-bench-readings-of-2026-10-13---the-owed-rows-a-bench-phone-can-settle)). **Owed: the same sign-in as a DIFFERENT account on a live process** - if it also skips the unlock, the previous account's key is reused ([auth](../frontend/modules/auth.md#two-iphone-12-findings-of-2026-10-07-a-name-saved-for-the-previous-account-and-a-reset-button-under-the-footer))
