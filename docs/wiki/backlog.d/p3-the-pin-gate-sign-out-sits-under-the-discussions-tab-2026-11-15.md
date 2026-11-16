## P3 - The PIN gate's one-tap "Se deconnecter" sits under the "Discussions" tab (Mi 9T, 2026-11-15)

target: 1.7.0

On the Mi 9T (`1.7.0-alpha.1`) the PIN gate draws its "Se deconnecter" at CSS 158-279 x 875-905, inside
the bottom bar's "Discussions" tab (218-327 x 873-921) underneath. The gate comes back on every new
document when the vault path is off - including the reloads the APP itself makes: `appVersion.ts`
after an update, the `MlsFatalErrorBanner` action, the `useChatSession` and `BaseMlsService`
recoveries, `indexeddb.ts`. A reflex tap on the tab bar there signs a real user out, in one tap,
through MiConnect's end-session. It is how the bench reading of 2026-11-15 signed alpha out twice
([sessions](../sessions.md#a-sign-out-names-who-decided-it-2026-11-15)). Nothing is lost - this exit
keeps `mls.bin`, the message database and the vault - but the person must sign in again, PIN included.

**Decided and built (owner, 2026-11-16; reading owed on both phones).** The sign-out left the footer
for a quiet top row (`[data-pin-signout-bar]` / `[data-pin-signout]` in `PinModal.svelte`), in flow
under the panel's top safe-area padding, outside the scrolling body, with a 44px hit box (`tap-target`)
and NO confirmation: the exit stays one tap, as decided for a gate that cannot be dismissed
(`handlePinSignOut` in `ChatBackgroundService.svelte`, which still calls `clearAuth('pin-gate')`). The
footer carries the unlock button alone. Pinned by `PinModal.exits.svelte.test.ts` (structure and the
safe-area chain; happy-dom has no layout).

**Closes when:** the gate's sign-out control does not intersect any bottom-bar tab on the Mi 9T and
the iPhone 12 (measured from the DOM, as above), pinned by a test on the gate's layout.

**iPhone geometry, 2026-11-16:** the same overlap on the iPhone 12 (TestFlight `1.7.0-alpha.2`): the gate's "Se deconnecter" at 127-263 x 761-794 points under the floating tab bar (y 761-844). The bench account was found signed out after the gate came up on a reload the app made itself and an unlock script ran; the `[A] logout` line was not flushed, so the exact tap is not read, but this is the candidate. See [device-verification](../device-verification.md#the-iphone-12-readings-of-2026-11-16-second-sitting-170-alpha2-the-staged-readings-cut-short-by-a-sign-out).

**Reading owed on both phones:** the Mi 9T and the iPhone 12 read the row from the DOM on the next
pre-release - it intersects no bottom-bar tab and clears the status bar and the notch. Then delete this entry.

**Mi 9T half read, 2026-11-16 (`1.7.0-alpha.4`, [readings](../device-verification.md#the-mi-9t-readings-of-2026-11-16-on-170-alpha4)): `PASS`.** The gate's "Se deconnecter" is at the top right (42-72 css px from the top, left 304, 121 wide), clear of the status bar, with nothing near the bottom tab bar. Still owed: the iPhone 12 half (the floating tab bar and the notch). Then delete this entry.

**iPhone half, 2026-11-16 (`1.7.0-alpha.4`): NOT READ.** `gamma` was signed out from the dashboard's "Se deconnecter" and signed back in through MiConnect's local password page; the app went straight to the feed and, after a terminate and relaunch, again with NO PIN gate (the device's vault path stayed on), so there was no gate to measure and "Rester connecte" was never offered to leave unticked. A gate on this phone needs a fresh device enrolment or the vault path off; neither was done. `gamma` was left signed in. Still owed: the iPhone half.
