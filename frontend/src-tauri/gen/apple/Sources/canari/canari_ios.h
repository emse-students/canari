#pragma once

/// Initialise les observateurs lifecycle iOS et le push (Firebase si disponible).
/// Appele depuis `main.mm` avant `ffi::start_app()`.
void canari_ios_bootstrap(void);

/// Vrai quand l'app est au premier plan (miroir `MainActivity.isInForeground`).
bool canari_ios_is_in_foreground(void);
