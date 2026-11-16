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

**The decision is queued with the owner.** Recommended (reversible): move the button out of the
tab-bar zone - higher in the gate, away from where a thumb lands on a tab - and add NO confirmation,
keeping the exit one tap as decided for a gate that cannot be dismissed (`handlePinSignOut` in
`ChatBackgroundService.svelte`). **If the owner does not answer, the lead takes the recommended
option under the absence rule**, since it is reversible, and writes it to the design page.

**Closes when:** the gate's sign-out control does not intersect any bottom-bar tab on the Mi 9T and
the iPhone 12 (measured from the DOM, as above), pinned by a test on the gate's layout.

**iPhone geometry, 2026-11-16:** the same overlap on the iPhone 12 (TestFlight `1.7.0-alpha.2`): the gate's "Se deconnecter" at 127-263 x 761-794 points under the floating tab bar (y 761-844). The bench account was found signed out after the gate came up on a reload the app made itself and an unlock script ran; the `[A] logout` line was not flushed, so the exact tap is not read, but this is the candidate. See [device-verification](../device-verification.md#the-iphone-12-readings-of-2026-11-16-second-sitting-170-alpha2-the-staged-readings-cut-short-by-a-sign-out).
