# iOS Firebase / APNs Integration Guide

Ce fichier documente les modifications à apporter après `tauri ios init`
pour activer les notifications push Firebase (APNs) sur iOS.

## Étape 1 — Lancer la génération du projet iOS (macOS requis)

```bash
cd frontend
bun tauri ios init
```

Cela crée `frontend/src-tauri/gen/apple/`.

## Étape 2 — Ajouter Firebase iOS SDK via Swift Package Manager

Dans Xcode → File → Add Package Dependencies :

```
https://github.com/firebase/firebase-ios-sdk
```

Sélectionner uniquement `FirebaseMessaging`.

## Étape 3 — Placer GoogleService-Info.plist

Copier le fichier depuis Firebase Console (Paramètres du projet → iOS),
et l'ajouter dans Xcode :

```
frontend/src-tauri/gen/apple/Canari_iOS/GoogleService-Info.plist
```

Ce fichier est gitignored (`gen/apple/.gitignore`) — il sera injecté
depuis le secret CI `GOOGLE_SERVICE_INFO_PLIST`.

## Étape 4 — Activer Push Notifications dans Xcode

Signing & Capabilities → + Capability → Push Notifications
Signing & Capabilities → + Capability → Background Modes → Remote notifications

## Étape 5 — Modifier AppDelegate.swift

Remplacer le contenu de `gen/apple/Sources/Canari/AppDelegate.swift` par :

```swift
import UIKit
import FirebaseCore
import FirebaseMessaging

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate,
                   UNUserNotificationCenterDelegate,
                   MessagingDelegate {

    static let PREFS_KEY_FCM_TOKEN = "fcm_token"

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {
        FirebaseApp.configure()
        Messaging.messaging().delegate = self

        UNUserNotificationCenter.current().delegate = self
        let authOptions: UNAuthorizationOptions = [.alert, .badge, .sound]
        UNUserNotificationCenter.current().requestAuthorization(
            options: authOptions
        ) { _, _ in }
        application.registerForRemoteNotifications()

        return true
    }

    // APNs → Firebase : transfert du device token APNs vers Firebase SDK
    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        Messaging.messaging().apnsToken = deviceToken
    }

    // Firebase → FCM token disponible ou renouvelé
    func messaging(_ messaging: Messaging, didReceiveRegistrationToken fcmToken: String?) {
        guard let token = fcmToken else { return }
        // Stocker dans UserDefaults pour que Rust/Tauri puisse le lire
        UserDefaults.standard.set(token, forKey: AppDelegate.PREFS_KEY_FCM_TOKEN)
        UserDefaults.standard.synchronize()
    }

    // Notification reçue en premier plan
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound, .badge])
    }
}
```

## Étape 6 — Exposer le token FCM depuis Rust (lib.rs)

Mettre à jour la commande `get_fcm_token` dans `lib.rs` pour gérer iOS :

```rust
#[tauri::command]
fn get_fcm_token(app: tauri::AppHandle) -> Option<String> {
    #[cfg(target_os = "android")]
    {
        // ... code Android existant (SharedPreferences via JNI)
    }

    #[cfg(target_os = "ios")]
    {
        use tauri::Manager;
        // Lire depuis UserDefaults via l'API iOS Tauri
        // (nécessite tauri-plugin-store ou un plugin natif custom)
        // Pour l'instant, lire via objc runtime :
        let token = unsafe {
            use std::ffi::CStr;
            // Appel Objective-C : [NSUserDefaults.standardUserDefaults stringForKey:@"fcm_token"]
            // À implémenter via tauri::ios ou objc crate
        };
        token
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = app;
        None
    }
}
```

> Note : L'accès à UserDefaults depuis Rust sur iOS requiert soit un plugin
> Tauri custom Swift, soit le crate `objc2`. À implémenter lors du
> développement iOS natif.

## Étape 7 — Variable d'environnement CI

Le secret GitHub `GOOGLE_SERVICE_INFO_PLIST` doit contenir le contenu
texte brut du fichier `GoogleService-Info.plist` (obtenu depuis Firebase
Console → Paramètres du projet → iOS → Télécharger GoogleService-Info.plist).

## Résumé des secrets GitHub nécessaires (iOS)

| Secret                       | Contenu                               |
| ---------------------------- | ------------------------------------- |
| `APPLE_SIGNING_IDENTITY`     | "Apple Distribution: EMSE (TEAMID)"   |
| `APPLE_CERTIFICATE_BASE64`   | Certificat .p12 encodé base64         |
| `APPLE_CERTIFICATE_PASSWORD` | Mot de passe du certificat .p12       |
| `APPLE_PROVISIONING_PROFILE` | Profil .mobileprovision encodé base64 |
| `APPLE_TEAM_ID`              | Identifiant équipe Apple Developer    |
| `GOOGLE_SERVICE_INFO_PLIST`  | Contenu de GoogleService-Info.plist   |
