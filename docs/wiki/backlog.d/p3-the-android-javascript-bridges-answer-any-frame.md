## P3 - the Android JavaScript bridges answer any frame the WebView loads (review of WP-C-BG-A, 2026-10-19; re-read 2026-11-11)

target: 1.8.0

`MainActivity` registers six bridges with `addJavascriptInterface`: `canariTheme`, `canariGestures`,
`canariBack`, `canariAudio`, `canariOrientation` and `canariCall`. Any frame the WebView loads can
reach them, not only the app's origin. `WebViewCompat.addWebMessageListener` takes an origin allowlist
and would bound them to the app's own origin.

Today the WebView loads only the embedded frontend, and each method does no more than the app itself
could. So this is hardening, not an open hole. The six move together.

The rest of the entry this came from (a call surviving the app leaving the screen, WP-C-BG-A #2162 and
WP-C-BG-I #2164, `v1.3.1`) is built. Its readings are a row of
[the readings owed](../plan.md#readings-owed).
