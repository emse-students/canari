### Fixed - a sign-out then a sign-in in the same process never unlocked

Every sign-out ran `clearAuth()` only and left the chat session live on the device; its foreground reconnect raced the next OIDC callback, and a latch left by the previous unlock turned the new one away ("Connexion en cours..." until a relaunch). `clearAuth` now ends the live session first - which also makes the sign-out reset of the announcement state actually run ([auth](docs/wiki/frontend/modules/auth.md#a-sign-out-ended-the-session-on-the-server-and-left-it-live-on-the-device---fixed-2026-10-14)).
