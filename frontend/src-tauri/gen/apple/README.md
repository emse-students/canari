# iOS (`gen/apple`) - fichiers custom Canari

<!--
  CE DOSSIER CONTIENT DU CODE CUSTOM - NE PAS ECRASER AVEC `tauri ios init` SANS REVUE.
  Comme Android (`gen/android/app/src/main/AndroidManifest.xml`), une re-init Tauri peut
  regenerer project.yml / pbxproj et EFFACER les ajouts Canari.

  Fichiers custom a preserver :
    - Sources/canari/canari_ios.mm   (lifecycle, Keychain push secret, FCM token)
    - Sources/canari/canari_ios.h
    - Sources/canari/canari_push.mm  (FCM background MLS)
    - Sources/canari/canari_push.h
    - Sources/canari/canari_rust_bridge.h
    - Sources/canari/main.mm         (appelle canari_ios_bootstrap)
    - canari_iOS/canari_iOS.entitlements (Associated Domains, push, App Group)
    - canari_iOS/{fr,en}.lproj/InfoPlist.strings (WP-iOS-10: localized privacy usage prompts). Ajouter les dossiers .lproj au target canari_iOS comme ressources localisees (Xcode detecte automatiquement les .lproj). Sans ce wiring dans le pbxproj, iOS retombe sur les valeurs FR de base de Info.plist.
    - canari_NSE/                    (Notification Service Extension: source + Info.plist + entitlements + bridging header + FFI header). Target ajoute A LA MAIN dans canari.xcodeproj (Xcode), pas via project.yml. Voir docs/wiki/infrastructure/ios-nse-setup.md
    - Podfile                        (Firebase/Messaging)
    - canari.xcodeproj/project.pbxproj (SOURCE DE VERITE du build : sources + frameworks + targets ajoutes a la main dans Xcode. project.yml n'est PAS lu par le build / la CI)

  Apres `tauri ios init` ou upgrade Tauri majeure : verifier que ces fichiers existent encore.
-->

## Setup Mac

```bash
cd frontend
bun install && bun run proto:gen
cd src-tauri/gen/apple && pod install
cd ../../..
bun run ios:dev
# Ouvrir canari.xcworkspace (pas .xcodeproj) si Firebase est installe
```

Copier `GoogleService-Info.plist` dans `canari_iOS/` (non committe, voir `.gitignore`).

## Parite Android

| Android | iOS |
|---------|-----|
| `MlsContextLoader.kt` | `CanariTauriDataDir()` dans `canari_ios.mm` |
| `PushSecretKeystore.kt` | Keychain (`canari_push_secret`) |
| `MainActivity.kt` (FCM token) | `CanariFcmDelegate` + `fcm_token.txt` |
| `CanariFirebaseMessagingService.kt` | `canari_push.mm` |
| `MlsBackgroundWorker` (janitor) | `canari_native_cleanup_pending_db` |
| JNI welcome/send/outbox | FFI C dans `ios_ffi.rs` |
| `nativeDecryptChannelMessage` (push channel) | `canari_native_decrypt_channel_message` |

## Phase 3 (welcome + outbox + worker)

`canari_push.mm` implemente en plus de la phase 2 :

- `welcome_request_pending` : verrou Redis, key package, create welcome (FFI), send-welcome-and-commit
- `isWelcome=true` : fetch-proto bundle, process welcome (FFI), membership-active
- `process_queue` : nettoyage `mls_pending.db` via FFI (equivalent worker Android)
- Drain `outbox_pending.ndjson` : chiffre (FFI), POST `/api/mls/push/send`, journal `outbox_sent.ndjson`
- Nudge "messages en attente" si outbox non vide (app fermee)
- Avatars expediteur (cache 24h + piece jointe notification)
- Annulation notif conversation sur push silencieux (read receipt multi-appareil)

## Rust

Pont iOS : `frontend/src-tauri/src/mobile/ios_ffi.rs`
Logique partagee Android/iOS : `frontend/src-tauri/src/mobile/background.rs`

FFI exposes :

- `canari_native_decrypt_message`
- `canari_native_group_epoch`
- `canari_native_decrypt_message_with_commits`
- `canari_native_decrypt_channel_message` (AES-256-GCM channel/communaute, hors MLS)
- `canari_native_create_welcome_background`
- `canari_native_process_welcome_background`
- `canari_native_send_message_background`
- `canari_native_cleanup_pending_db`
