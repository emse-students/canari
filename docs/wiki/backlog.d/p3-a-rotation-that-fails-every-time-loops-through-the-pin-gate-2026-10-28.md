## P3 - A rotation that fails every time loops through the PIN gate (2026-10-28)

target: 1.9.0

A device identity rotation that fails on every attempt (a disk that refuses every checkpoint, say)
makes a loop: PIN gate -> unlock -> the key-package round is answered "revoked" -> the rotation fails
-> the session is lost -> PIN gate. Each lap costs the member one PIN entry and is logged at ERROR
(`reportMlsSessionLost`); nothing is revoked or erased, so the loop is visible and harmless but not
broken. Owed: a durable count of consecutive failed rotations for this install that, past a bound,
stops the unlock with its own typed outcome instead of another lap
([mls-protocol](../protocols/mls-protocol.md#the-native-manager-does-not-outlive-its-account-2026-10-27)).

**Brief for an agent (batch 15, 2026-11-12; MLS and native - opus, adversarial review before each merge, every PR born `--draft`).** A durable count of consecutive failed rotations for this install (stored beside the MLS state, reset by the first success), and past a bound decided in the PR, the unlock answers its own typed outcome (a screen that says the device cannot renew its identity and offers sign-out) instead of another lap. Termination from that durable proof, never a clock. Tests: N failures stop the loop; one success resets the count; a count from another account is not read.
