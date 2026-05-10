# Stockage & Mémoire — Canari

Ce document décrit chaque couche de stockage utilisée par Canari, ce qui y est rangé, et les garanties de persistance sur web et Android Tauri.

---

## Vue d'ensemble

```
┌─────────────────────────────────────────────────────────────┐
│  Mémoire vive (perdue au kill du processus)                 │
│  • Access token JWT                                         │
│  • Ratchet MLS (état courant du groupe en session)          │
│  • Clé PBKDF2 dérivée du PIN (cache)                        │
└─────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────┐
│  sessionStorage (perdu à la fermeture de l'onglet/app)      │
│  • Clé de chiffrement PIN (canari_pin_vault_key)            │
│  • Blob PIN chiffré (canari_pin_vault)                      │
│  • Token FCM session (canari_fcm_token)                     │
│  • Nonce OIDC callback (oidc_code_<code>)                   │
└─────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────┐
│  localStorage WebView (partagé web & Tauri)                 │
│  Persisté sur disque par le moteur WebView.                 │
│  Sur Android : dans /data/data/fr.emse.canari/app_webview/  │
└─────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────┐
│  Cookie HttpOnly (géré par le serveur & WebView)            │
│  • canari_refresh — refresh token JWT 7 jours               │
└─────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────┐
│  Stockage natif (hors portée du WebView)                    │
│  Web    : IndexedDB (messages, groupes)                     │
│  Tauri  : SQLite tauri-plugin-sql  +  fichiers app_data_dir │
└─────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────┐
│  Android Keystore (hardware-backed, survit à tout)          │
│  • Secret biométrique (PIN chiffré par l'empreinte)         │
│  • Push secret (clé de déchiffrement notifications FCM)     │
└─────────────────────────────────────────────────────────────┘
```

---

## 1. Mémoire vive

Perdue à chaque redémarrage du processus. Toujours récupérée au démarrage par d'autres couches.

| Donnée | Récupération au démarrage |
|--------|--------------------------|
| Access token JWT (15 min) | `POST /api/auth/refresh` avec le cookie `canari_refresh` |
| Ratchet MLS | Chargé depuis `mls.bin` / `mls_state_checkpoint` (SQLite) |
| Clé PBKDF2 dérivée du PIN | Recalculée à la saisie du PIN (ou depuis `canari_pin_vault` en sessionStorage) |

---

## 2. sessionStorage

Intentionnellement éphémère — vidé à la fermeture de l'onglet/app. Aucune migration prévue.

| Clé | Contenu | Durée de vie |
|-----|---------|--------------|
| `canari_pin_vault_key` | Clé AES-GCM qui chiffre le PIN | Session |
| `canari_pin_vault` | PIN chiffré `iv:ciphertext` en base64 | Session |
| `canari_fcm_token` | Token FCM en cours d'utilisation | Session |
| `canari_pending_contact` | ID de contact transmis entre pages | Quelques secondes (consommé immédiatement) |
| `oidc_code_<code>` | Nonce de dédoublonnage callback OIDC | Session |

---

## 3. localStorage WebView

Partagé entre web et Tauri Android. Sur Android, stocké dans le répertoire géré par le WebView (distinct du stockage natif Tauri).

### Données critiques

| Clé | Contenu | Risque si perdu | Mitigation |
|-----|---------|-----------------|------------|
| `mls_device_id_<userId>` | UUID du device MLS | Nouveau device généré → exclure des groupes existants | Sauvegardé dans `push_context.json` (Rust). `TauriMlsService` relit le fichier en priorité. |
| `canari_enc_salt:<dbPath>` | Sel PBKDF2 pour chiffrer la DB locale | DB locale illisible (mauvaise clé) | **Pas de backup actuellement.** Si le salt est perdu, la DB locale doit être réinitialisée, mais les messages sont re-fetchables depuis le serveur (Redis Stream). |
| `history_last_stream_id:<userId>:<groupId>` | Dernier ID Redis Stream vu | Re-fetch de tout l'historique au prochain démarrage | Dégradation gracieuse : performances dégradées, pas de perte de données |
| `history_seen_cipher:<userId>:<groupId>` | Hashes des ciphertexts déjà traités (max 5000) | Re-traitement possible de messages déjà vus | Les messages sont dédoublonnés par ID en base → pas de duplicata affiché |

### Données non critiques

| Clé | Contenu | Impact si perdu |
|-----|---------|-----------------|
| `canari_saved_user` | ID utilisateur courant | Re-extrait du JWT sub claim au refresh |
| `canari_user_email` | Email de l'utilisateur | Re-fetchable via `/api/users/:id` |
| `canari_user_display_name` | Nom affiché | Re-fetchable |
| `canari_global_admin` | Flag admin | Re-extrait du JWT |
| `canari_oidc_state` | Nonce CSRF login | Consommé en quelques secondes, valeur perdue = re-login |
| `canari_oidc_return` | URL de retour post-login | Retour vers `/chat` par défaut |
| `canari-theme` | Thème clair/sombre | Retour au thème par défaut |
| `canari_recent_emojis` | Emojis récents | Réinitialisé |
| `canari_biometric_configured` | Flag activation biométrie | **Dupliqué dans `native_flags.json`** (Rust). Restauré automatiquement. |
| `canari_sync_guide_seen_<userId>` | Flag "guide sync vu" | Guide affiché à nouveau |
| `device-name:<userId>:<deviceId>` | Nom lisible du device | Re-fetchable |
| `mls_autosave_<userId>` | Ancienne clé legacy MLS | Migration vers IndexedDB déjà faite, clé supprimée au démarrage |
| `canari_conv_<userId>_<contactName>` | Ancienne clé legacy conversations | Migration vers IndexedDB déjà faite, clé supprimée au démarrage |

### Spécificités Android (Tauri)

Sur Android avec `targetSdkVersion ≥ 21`, le WebView **bloque par défaut les cookies tiers**. Depuis `tauri://localhost`, `canari-emse.fr` est considéré tiers. Sans action, le cookie `canari_refresh` n'est jamais stocké ni envoyé.

**Fix appliqué** dans `MainActivity.kt` : `CookieManager.setAcceptThirdPartyCookies(webView, true)`.

`CookieManager.flush()` est appelé dans `onPause()` et `onStop()` pour garantir l'écriture sur disque avant un kill du processus.

---

## 4. Cookie HttpOnly

| Cookie | Domaine | Durée | Flags |
|--------|---------|-------|-------|
| `canari_refresh` | `canari-emse.fr` | 7 jours | `HttpOnly; Secure; SameSite=None; Path=/api/auth` |

Le cookie est positionné par `core-service` lors du login OIDC ou d'un refresh réussi. Il est inaccessible depuis JavaScript. Le WebView Android le gère via son `CookieManager`.

`SameSite=None` est requis car l'app Tauri fait des requêtes cross-origin (`tauri://localhost → canari-emse.fr`).

---

## 5. Stockage natif Tauri (hors WebView)

Localisé dans `app_data_dir` (Android : `/data/data/fr.emse.canari/files/`). Jamais vidé par le WebView ni par les OEM.

### Fichiers

| Fichier | Contenu | Géré par |
|---------|---------|----------|
| `mls.bin` | État MLS chiffré (binaire, AEAD ChaCha20) | Rust + TypeScript |
| `mls_pending.db` | Messages MLS en attente de traitement (gap recovery) | SQLite Rust |
| `push_context.json` | PIN, userId, deviceId, baseUrl, pushToken | Rust (`store_push_context`) |
| `native_flags.json` | Flags booléens UI (ex: `biometricConfigured`) | Rust (`set_native_flag`, `get_native_flags`) |
| `fcm_token.txt` | Token FCM persisté entre sessions | Rust (`notify_fcm_token`) |
| `pending_push_secret.txt` | Secret push en transit (supprimé après lecture) | Rust → Keystore Android |

### SQLite tauri-plugin-sql

Base de données gérée par le plugin TypeScript `tauri-plugin-sql`. Fichier `.db` dans `app_data_dir`.

Contient : conversations, messages, groupes MLS, `seenCipherHashes`, `lastStreamId`. Ce stockage **remplace** IndexedDB sur Tauri et est persistant.

### SQLite interne Rust (`mls_pending.db`)

Géré directement par Rust (sqlx). Tables :

| Table | Contenu |
|-------|---------|
| `pending_mls_messages` | Ciphertexts en attente de déchiffrement (gap/epoch) |
| `mls_state_checkpoint` | Snapshot de `mls.bin` sauvegardé atomiquement après chaque message traité |
| `mls_failure_counts` | Compteur d'échecs consécutifs par groupe (déclenche re-bootstrap après 3) |

---

## 6. IndexedDB (web uniquement)

Utilisé sur le navigateur (non-Tauri). Même structure que SQLite Tauri.

La clé de chiffrement est dérivée du PIN + `canari_enc_salt` (localStorage). Si le salt est perdu, les données IndexedDB sont inaccessibles — mais les messages sont re-fetchables depuis Redis Stream.

---

## 7. Android Keystore

Stockage hardware-backed. Accessible uniquement via authentification biométrique (ou PIN système). Jamais exportable.

| Secret | Alias Keystore | Géré par |
|--------|---------------|----------|
| PIN chiffré par biométrie | Alias interne `@impierce/tauri-plugin-keystore` | `BiometricService.enableBiometric()` |
| Push secret (déchiffrement notifications FCM hors session) | Alias `PushSecretKeystore` | `CanariApplication.processPendingPushSecret()` |

---

## Cycle de vie au redémarrage de l'app (Android Tauri)

```
App ouverte
    │
    ├── Cookie canari_refresh présent ?
    │       ├── Oui → POST /api/auth/refresh → access token en mémoire → session OK
    │       └── Non → /login
    │
    ├── localStorage canari_saved_user présent ?
    │       ├── Oui → userId chargé
    │       └── Non → userId extrait du JWT sub claim après refresh réussi
    │
    ├── mls_device_id présent en localStorage ?
    │       ├── Oui → utilisé tel quel
    │       └── Non → restauré depuis push_context.json (deviceId) si userId correspond
    │
    ├── mls.bin présent en app_data_dir ?
    │       ├── Oui → état MLS chargé et déchiffré avec le PIN
    │       └── Non → fallback sur mls_state_checkpoint (SQLite) → ou fresh start
    │
    └── canari_biometric_configured présent en localStorage ?
            ├── Oui → biométrie disponible au démarrage
            └── Non → restauré depuis native_flags.json
```

---

## Ce qu'il reste à migrer (risques résiduels)

| Item | Risque | Priorité |
|------|--------|----------|
| `canari_enc_salt:<dbPath>` | Si localStorage vidé, la DB locale (SQLite/IndexedDB) devient illisible. Les messages restent re-fetchables depuis le serveur, mais la session locale est perdue. | Moyenne — pas de perte définitive |
| `history_last_stream_id` | Re-fetch complet de l'historique au prochain démarrage | Basse — performance seulement |
| `history_seen_cipher` | Re-traitement de messages déjà vus | Basse — dédoublonnage par ID empêche les duplicatas |

Pour `canari_enc_salt`, la migration consisterait à le stocker dans `push_context.json` ou un fichier dédié via une commande Rust, et à le relire au démarrage si localStorage est vide.
