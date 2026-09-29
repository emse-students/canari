// swift-tools-version:5.9

import PackageDescription

let package = Package(
    name: "tauri-plugin-system-components",
    platforms: [
        // The tab bar (and the rest of the plugin) works from iOS 14; the only
        // iOS-15 API — UIButton.Configuration in the components overlay — is
        // guarded with `#available(iOS 15, *)` and falls back below it. Keeping
        // the floor at 14 lets the plugin link into apps that target iOS 14
        // (Tauri's default) rather than forcing every consumer up to 15.
        .iOS(.v14),
        .macOS(.v12),
    ],
    products: [
        .library(
            name: "tauri-plugin-system-components",
            type: .static,
            targets: ["tauri-plugin-system-components"]),
    ],
    dependencies: [
        // Tauri runtime injected as a sibling local package by the Tauri CLI
        // when the consumer runs `tauri ios init` / `tauri ios dev`.
        .package(name: "Tauri", path: "../.tauri/tauri-api"),
    ],
    targets: [
        .target(
            name: "tauri-plugin-system-components",
            dependencies: [
                .byName(name: "Tauri"),
            ],
            path: "Sources"),
    ]
)
