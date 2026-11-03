## P2 - a cancelled iOS sign-in sheet leaves the login button on "Redirection..." until the app is killed (found 2026-11-03)

On the iPhone, `openCustomTab` resolves as soon as the `ASWebAuthenticationSession` is presented, and
its completion handler drops a cancellation (the sheet's close button, "Annuler" on the consent alert)
without telling the page (`frontend/src-tauri/plugins/tauri-plugin-customtabs/ios/Sources/CustomTabsPlugin.swift`).
`LoginPage.svelte` resets its busy flag only on `visibilitychange`, `focus` or the native foreground
edge, and an in-app sheet raises none of them, so the button stays disabled on "Redirection..." with
no sheet on screen; only a kill and relaunch gives it back. Unchanged since WP-OIDC-TAB-1 (August):
not a `1.6.3` regression. Read on the bench 2026-11-03 (`1.6.3-alpha.7`): the stalled screen of the
first pass, then a full sign-in through the same sheet that succeeded
([device-verification](../device-verification.md)). The fix is native (the plugin reports the
session's end, the page releases the button on it) and is verified only by an iOS build and a tap on
the sheet's close button.
