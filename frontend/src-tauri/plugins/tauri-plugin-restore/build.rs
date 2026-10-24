// Every command reachable from JS must be listed here: the ACL is generated from this list, and a
// command missing from it is rejected at the IPC boundary at runtime with no compile-time hint.
const COMMANDS: &[&str] = &[
    "create_restore_credential",
    "get_restore_credential",
    "clear_restore_credential",
];

// ANDROID ONLY, and no `ios_path`: Restore Credentials is a Google Play services API with no iOS
// counterpart (docs/wiki/account-restore.md). On iOS and the desktop every command answers
// `Error::Unsupported`, and the frontend never asks there (`isAndroidTauriRuntime()`).
fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
