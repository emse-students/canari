## P3 - Android logs `checkKeystoreHealth: Keystore lost - background push disabled` at ERROR during an ordinary sign-out and sign-in (S17, 2026-11-20)

target: 1.7.3

Read on the Mi 9T, `1.7.2-alpha.2`, sitting S17 of 2026-11-20: `E/CanariApp: checkKeystoreHealth: Keystore lost - background push disabled` is logged TWICE during an ordinary sign-out and sign-in, right after `endForSignOut: erasing the push secret`. The keystore was not lost: the app had just erased the secret itself, so the health check reads its own erasure as a loss. **A false ERROR**, which accuses a healthy phone and teaches the reader to skip the real one (noise is never acceptable).

The fix belongs where the check decides: it must know that a sign-out erased the secret on purpose (carry the fact to the check, not a delay), and log nothing at that level for it. Verify with a sign-out and sign-in on the Mi 9T that the line is absent and that a genuinely lost key still logs it. Context: [mobile](../frontend/mobile.md).
