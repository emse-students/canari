## P2 - the Rust half of a push handled in a KILLED Android app logs nowhere (2026-09-27, re-read 2026-11-11)

`tauri_plugin_log` installs the logger when Tauri starts; a push in a dead app calls Rust through
JNI without it, so every `[PushBG]` line of `mobile/background.rs` is lost - exactly the lines a
killed-app notification defect needs. `JNI_OnLoad` (`frontend/src-tauri/src/lib.rs`) still installs
no logger on 2026-11-11. One installed there would take the global slot from the plugin at a normal
start, so the two must be reconciled (one logger, the plugin's sink added when Tauri starts), not
stacked. Native: proven only by a Mi 9T logcat of a push with the app force-stopped, the `[PushBG]`
lines present. Mechanism: [mobile](../frontend/mobile.md).
