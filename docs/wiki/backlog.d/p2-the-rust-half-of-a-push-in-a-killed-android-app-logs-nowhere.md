## P2 - the Rust half of a push handled in a KILLED Android app logs nowhere (2026-09-27, re-read 2026-11-11)

target: 1.9.0

`tauri_plugin_log` installs the logger when Tauri starts; a push in a dead app calls Rust through
JNI without it, so every `[PushBG]` line of `mobile/background.rs` is lost - exactly the lines a
killed-app notification defect needs. `JNI_OnLoad` (`frontend/src-tauri/src/lib.rs`) still installs
no logger on 2026-11-11. One installed there would take the global slot from the plugin at a normal
start, so the two must be reconciled (one logger, the plugin's sink added when Tauri starts), not
stacked. Native: proven only by a Mi 9T logcat of a push with the app force-stopped, the `[PushBG]`
lines present. Mechanism: [mobile](../frontend/mobile.md).

**Seen again on 2026-11-17, `1.7.0-alpha.9`, dev** ([device-verification](../device-verification.md#the-phone-readings-of-2026-11-17-170-alpha9-both-phones-and-the-rig)):
a re-admission Welcome reached the Mi 9T with the app killed (`am kill`), and CanariFCM wrote only
`processReceivedWelcomeBackground: join failed group=<key group>`. The Rust cause
(`[BG_JOIN] nativeProcessWelcomeBackground failed: ...`) is one of the lines this entry loses, and the
JNI call returns a bare `false`, so even with a logger the Kotlin side cannot say why. The cause was
read afterwards from the foreground start (`[WELCOME] key group ... already held - redelivered Welcome
ignored (idempotent)`, then the leaf found gone and an external-commit re-join). So the fix carries
two halves: the logger above, and a typed outcome back across JNI, so that "a Welcome for a group the
state already holds" is a named case logged at its own level, not a failure.
