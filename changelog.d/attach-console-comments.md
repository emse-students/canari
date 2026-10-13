### Fixed - comments no longer claim `attachConsole()` sends the JS console to logcat

It copies Rust log records into the JS console, and receives none because no `Webview` target is configured. JavaScript reaches logcat only through wry's `onConsoleMessage`, which runs on debug builds only, so a release build logs no JavaScript ([+layout.svelte](frontend/src/routes/+layout.svelte), [harness README](tools/cross-client-harness/README.md)).
