// Every command reachable from JS must be listed here: the ACL is generated from this list, and a
// command missing from it is rejected at the IPC boundary at runtime with no compile-time hint.
const COMMANDS: &[&str] = &["open_custom_tab"];

fn main() {
    // No `.ios_path(...)`: this plugin is Android-only (WP-OIDC-TAB-1 scope). iOS keeps the
    // plain system-browser launch via tauri-plugin-opener; its equivalent fix would be
    // ASWebAuthenticationSession, a separate native surface, not this plugin.
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
