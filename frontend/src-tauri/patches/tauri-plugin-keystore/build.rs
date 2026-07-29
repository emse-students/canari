// Every command reachable from JS must be listed here: the ACL is generated from this list, and a
// command missing from it is rejected at the IPC boundary at runtime with no compile-time hint.
// The *_key_bytes commands were absent until v0.11.4, which is why the JS-side keystore calls
// silently returned false.
const COMMANDS: &[&str] = &[
    "store_key_bytes",
    "get_key_bytes",
    "delete_key_bytes",
    "has_key_bytes",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .ios_path("ios")
        .build();
}
