// Every command reachable from JS must be listed here: the ACL is generated from this list, and a
// command missing from it is rejected at the IPC boundary at runtime with no compile-time hint.
const COMMANDS: &[&str] = &["open_custom_tab"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .ios_path("ios")
        .build();
}
