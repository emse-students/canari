const COMMANDS: &[&str] = &[
    "configure_tab_bar",
    "remove_tab_bar",
    "show_tab_bar",
    "hide_tab_bar",
    "select_tab",
    "set_badge",
    "get_tab_bar_insets",
    "present_sheet",
    "dismiss_sheet",
    "create_component",
    "update_component",
    "update_components",
    "remove_component",
    "is_glass_supported",
    "set_window_glass",
    "clear_window_glass",
    // Required for addPluginListener() — the JS side invokes
    // plugin:system-components|register_listener to receive `trigger`ed events,
    // and remove_listener when the returned PluginListener unregisters.
    "register_listener",
    "remove_listener",
];

fn main() {
    // Cargo treats this crate as fresh when only the iOS Swift sources change,
    // so `tauri ios dev` would relink previously-compiled Swift and silently
    // ship stale native UI. Watch the Swift package explicitly so any edit
    // under `ios/` reliably triggers a rebuild + relink.
    println!("cargo:rerun-if-changed=ios/Sources");
    println!("cargo:rerun-if-changed=ios/Package.swift");

    tauri_plugin::Builder::new(COMMANDS)
        .ios_path("ios")
        .android_path("android")
        .build();
}
