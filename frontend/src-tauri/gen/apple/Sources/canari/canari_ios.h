#pragma once

/// Installs the iOS lifecycle observers and the push handler (Firebase when available).
/// Appele depuis `main.mm` avant `ffi::start_app()`.
void canari_ios_bootstrap(void);

/// True while the app is in the foreground (mirror of `MainActivity.isInForeground`).
bool canari_ios_is_in_foreground(void);
