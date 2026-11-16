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

**Reading owed on both phones:** the Mi 9T and the iPhone 12 read the row from the DOM on the next
pre-release - it intersects no bottom-bar tab and clears the status bar and the notch. Then delete this entry.
