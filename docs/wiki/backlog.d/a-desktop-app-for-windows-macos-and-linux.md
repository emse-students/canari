## A desktop app for Windows, macOS and Linux, distributed unsigned (owner, 2026-11-27)

target: 1.10.0

**macOS is not urgent at all (owner, 2026-11-27: *"Mac ça ne presse pas du tout du tout"*)**: Windows
and Linux are the `1.10.0` scope; the macOS build may follow later without holding the version. Windows
is read on the lead's Windows machine, Linux by a CI build and launch (no Linux desktop on the bench).

**Decided by the owner on 2026-11-27:** build it after the reliability tiers, on all three desktop
platforms, and distribute the binaries **unsigned** (no code-signing certificate, no Microsoft Store).
The owner accepts the consequence: Windows SmartScreen ("Windows a protégé votre ordinateur") on
every install, and Gatekeeper's refusal on macOS until the user allows it in the system settings.

**Half of it already exists.** Nothing ships a desktop binary today: `android.yml` and `ios.yml` are
the only native builds. But the Tauri project already targets the desktop:

- `frontend/src-tauri/tauri.conf.json` bundles `"targets": "all"` (NSIS/MSI, `.dmg`, AppImage/`.deb`)
  and carries `icon.ico` and `icon.icns`;
- `lib.rs` has `#[cfg(desktop)]` paths: a tray icon with an "Afficher Canari" menu, a close that hides
  the window instead of quitting (so the socket, and the notifications, survive), and a fixed local
  port in release builds;
- `keystore_bridge.rs` falls back to the OS keyring on the desktop;
- [account-restore](../account-restore.md) already names `http://tauri.localhost` as the origin of the
  Windows app (WebView2).

**What is owed.**

1. **A build in CI**: a desktop job per OS (Windows, macOS, Linux runners), called from `release.yml`
   as a `workflow_call` library, never a fifth visible workflow ([cicd](../cicd.md)). The artefacts
   are attached to the GitHub release. Whether a pre-release ships them too is decided when it is
   built.
2. **Updates without a store**: `tauri-plugin-updater` reading a signed update manifest published on
   the GitHub release. Its signature is Tauri's own update key (a secret to add to
   `infrastructure/MIGRATION.md`), independent of the unsigned installer.
3. **macOS unsigned and un-notarized** is the owner's choice. If Gatekeeper's friction proves too high,
   notarization with the existing Apple account is the reversible way out.
4. **A reading per release on a real machine of each OS**, like the phones
   ([device-verification](../device-verification.md)).
5. **Never compiled on this workstation yet**: the first step is `bun tauri build` on Windows, read
   end to end.

**Why it matters beyond itself.** A native desktop app can open a raw TCP connection, which a browser
page cannot. That is the precondition of the mail client on the apps, in
[mail-client](../mail-client.md).
