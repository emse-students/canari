### Fixed - the web server no longer imports a package its image does not ship

The `v1.8.2-alpha.5` dev deploy was refused: the in-app browser gate reached `@tauri-apps/plugin-os` through the store URLs, and the new server replica could not start (the old one kept serving; production was never touched). The store URLs moved to a module with no dependency, and the production build now fails when the server imports any package ([architecture](docs/wiki/frontend/architecture.md#the-server-half-imports-no-package-2026-11-26)).
