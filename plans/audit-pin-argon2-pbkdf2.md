# Audit Exhaustif — Argon2id / PBKDF2 / PIN dans tout le codebase

> **Date :** 2026-07-27  
> **Périmètre :** `frontend/mls-core/src/`, `frontend/mls-wasm/src/`, `frontend/src/lib/`, `frontend/src-tauri/src/`, `frontend/src-tauri/gen/android/`  
> **Référence :** [`plan-remplacement-pin-par-devicekey.md`](plan-remplacement-pin-par-devicekey.md)

---

## Légende

| Abréviation | Signification |
|---|---|
| ✅ **DÉJÀ MIGRÉ** | Fonctionne déjà avec `deviceKeyB64`, aucune action nécessaire |
| 🔄 **À MIGRER** | Concerné par le plan de remplacement, doit passer à `deviceKeyB64` |
| ⚠️ **À MIGRER (plan incomplet)** | Usage oublié ou sous-estimé par le plan existant, doit être ajouté |
| 🛡️ **CONSERVÉ** | PIN requis pour l'authentification serveur ou usage non-chiffrement, hors scope |
| ❌ **À SUPPRIMER** | Fonction mortelle après migration de tous les appelants |

---

## Partie 1 — Argon2id

### 1.1 Couche Rust — `mls-core/src/security.rs` (coeur cryptographique)

| # | Fichier:ligne | Fonction | Rôle Argon2id | Statut | Couvert par le plan ? |
|---|---|---|---|---|---|
| 1 | [`security.rs:13-20`](frontend/mls-core/src/security.rs:13) | `derive_key_from_pin(pin: &str, salt: &[u8]) -> [u8;32]` | **Argon2id hash → clé 32B**. Dépréciée au profit de `_owned`. | 🔄 À MIGRER | ✅ Oui — §5.2, conservée `#[deprecated]` pour changePIN |
| 2 | [`security.rs:25-29`](frontend/mls-core/src/security.rs:25) | `derive_key_from_pin_owned(mut pin: String, salt: &[u8]) -> [u8;32]` | Idem + `pin.zeroize()`. Appelée par `derive_and_store_device_key`. | 🔄 À MIGRER | ✅ Oui — §5.2, conservée pour premier login + changePIN |
| 3 | [`security.rs:58-69`](frontend/mls-core/src/security.rs:58) | `encrypt_state_with_pin(pin: &str, plain_state: &[u8]) -> Vec<u8>` | **Argon2id + ChaCha20-Poly1305**. Format `[salt 16][nonce 12||ciphertext]`. Dépréciée. | ❌ À SUPPRIMER | ✅ Oui — §5.1 |
| 4 | [`security.rs:74-81`](frontend/mls-core/src/security.rs:74) | `encrypt_state_with_pin_owned(mut pin: String, plain_state: &[u8]) -> Vec<u8>` | Variante `_owned` avec zeroize. Appelée par WASM `encrypt_with_pin`. | ❌ À SUPPRIMER | ✅ Oui — §5.1 |
| 5 | [`security.rs:95-112`](frontend/mls-core/src/security.rs:95) | `derive_and_store_device_key(pin: String, salt, alias, keystore) -> [u8;32]` | **Argon2id → keystore best-effort**. Zeroize le PIN. Appelée par `load_encrypted_with_keystore`, `store_push_context`, `actualiser_cle_keystore`. | ✅ DÉJÀ MIGRÉ | ✅ Oui — conservée, c'est le mécanisme de dérivation initiale |

### 1.2 Couche Rust — `mls-core/src/crypto.rs` (gestionnaire MLS)

| # | Fichier:ligne | Fonction | Rôle Argon2id | Statut | Couvert par le plan ? |
|---|---|---|---|---|---|
| 6 | [`crypto.rs:14-17`](frontend/mls-core/src/crypto.rs:14) | `encrypt_state_blob(plain_state: &[u8], pin: &str) -> Vec<u8>` | Wrapper statique → `encrypt_state_with_pin`. Utilisable hors thread (Web Worker). | ❌ À SUPPRIMER | ✅ Oui — §5.1 |
| 7 | [`crypto.rs:20-23`](frontend/mls-core/src/crypto.rs:20) | `save_encrypted(&self, pin: &str) -> Vec<u8>` | Sauvegarde CBOR + Argon2id chiffrement. Dépréciée. | ❌ À SUPPRIMER | ✅ Oui — §5.1 |
| 8 | [`crypto.rs:27-31`](frontend/mls-core/src/crypto.rs:27) | `save_encrypted_owned(&self, mut pin: String) -> Vec<u8>` | Variante zeroize. Appelée par `sauvegarder_mls` (Tauri). | ❌ À SUPPRIMER | ✅ Oui — §5.1 |
| 9 | [`crypto.rs:39-49`](frontend/mls-core/src/crypto.rs:39) | `save_encrypted_with_key(&self, key: &[u8;32]) -> Vec<u8>` | **Sans Argon2id** — clé 32B directe. Utilisé par background push. | ✅ DÉJÀ MIGRÉ | ✅ Oui — conservée |
| 10 | [`crypto.rs:52-77`](frontend/mls-core/src/crypto.rs:52) | `load_encrypted(user_id, device_id, blob, pin: &str)` | **Argon2id déchiffrement**. Dépréciée. | ❌ À SUPPRIMER | ✅ Oui — §5.1 |
| 11 | [`crypto.rs:81-90`](frontend/mls-core/src/crypto.rs:81) | `load_encrypted_owned(user_id, device_id, blob, mut pin: String)` | Variante zeroize. Appelée par `initialiser_mls` (Tauri). | ❌ À SUPPRIMER | ✅ Oui — §5.1 |
| 12 | [`crypto.rs:102-164`](frontend/mls-core/src/crypto.rs:102) | `load_encrypted_with_keystore(user_id, device_id, blob, pin: Option<String>, keystore)` | **Path B = Argon2id via `derive_and_store_device_key`**. Path A = keystore direct. | 🔄 À MIGRER | ✅ Oui — §3.1, simplifier pour que le frontend récupère `deviceKeyB64` |
| 13 | [`crypto.rs:171-191`](frontend/mls-core/src/crypto.rs:171) | `load_with_key(user_id, device_id, blob, key: &[u8;32]) -> Self` | **Sans Argon2id** — clé 32B directe. Devient le chemin principal. | ✅ DÉJÀ MIGRÉ | ✅ Oui — conservée, devient le chemin principal |

### 1.3 Couche WASM — `mls-wasm/src/pin_crypto.rs`

| # | Fichier:ligne | Fonction | Rôle Argon2id | Statut | Couvert par le plan ? |
|---|---|---|---|---|---|
| 14 | [`pin_crypto.rs:7-13`](frontend/mls-wasm/src/pin_crypto.rs:7) | `encrypt_with_pin(pin: &str, data: &[u8]) -> Vec<u8>` | **Argon2id via `encrypt_state_with_pin_owned`**. Appelée par `backup.ts`, `encryptMlsStateOnMainThread`, `encryptMlsStateOffThread`. | ❌ À SUPPRIMER | ✅ Oui — §3.2, remplacée par `encrypt_with_key` |
| 15 | [`pin_crypto.rs:16-32`](frontend/mls-wasm/src/pin_crypto.rs:16) | `decrypt_with_pin(pin: &str, encrypted_data: &[u8]) -> Vec<u8>` | **Argon2id via `derive_key_from_pin_owned`**. Appelée par `backup.ts`, `loadAndInitWasm`. | ❌ À SUPPRIMER | ✅ Oui — §3.2, remplacée par `decrypt_with_key` |

### 1.4 Couche TypeScript — Chiffrement MLS (via WASM)

| # | Fichier:ligne | Fonction | Rôle Argon2id | Statut | Couvert par le plan ? |
|---|---|---|---|---|---|
| 16 | [`mlsWasmLoader.ts:104-108`](frontend/src/lib/mls-client/mlsWasmLoader.ts:104) | `encryptMlsStateOnMainThread(plain, pin: string)` | Appelle WASM `encrypt_with_pin` → Argon2id. Fallback quand les workers sont désactivés. | 🔄 À MIGRER | ✅ Oui — §3.4 |
| 17 | [`mlsEncryptWorkerSession.ts:70-77`](frontend/src/lib/mls-client/mlsEncryptWorkerSession.ts:70) | `encryptMlsStateOffThread(plain, pin, options)` | Argon2id off-thread via `encrypt_with_pin`. | 🔄 À MIGRER | ✅ Oui — §3.4 |
| 18 | [`WebMlsService.ts:618-627`](frontend/src/lib/services/WebMlsService.ts:618) | `saveState(pin: string)` | CBOR plain sur main thread → Argon2id off-thread. | 🔄 À MIGRER | ✅ Oui — §3.4 (`saveState(deviceKeyB64)`) |
| 19 | [`WebMlsService.ts:614-616`](frontend/src/lib/services/WebMlsService.ts:614) | `encryptState(plain, pin: string)` | Délégue à `encryptMlsStateOffThread`. | 🔄 À MIGRER | ✅ Oui — §3.4 |
| 20 | [`WebMlsService.ts:592-594`](frontend/src/lib/services/WebMlsService.ts:592) | `loadStateWithPin(pin: string, state?)` | Appelle `loadAndInitWasm(userId, deviceId, state, pin)` → Argon2id. | 🔄 À MIGRER | ✅ Oui — §3.4 (`loadStateWithKey`) |
| 21 | [`WebMlsService.ts:122-123`](frontend/src/lib/services/WebMlsService.ts:122) | `reloadClientFromState(state, pin: string)` | `loadAndInitWasm` avec PIN → Argon2id. | 🔄 À MIGRER | ✅ Oui — §3.4 |
| 22 | [`TauriMlsService.ts:547-556`](frontend/src/lib/services/TauriMlsService.ts:547) | `loadStateWithPin(pin: string, state?)` | Stocke `this._pin = pin`, appelle `initialiser_mls` (Tauri) → Argon2id. | 🔄 À MIGRER | ✅ Oui — §3.4 (`loadStateWithKey`) |
| 23 | [`TauriMlsService.ts:498-505`](frontend/src/lib/services/TauriMlsService.ts:498) | `saveState(pin: string)` | Appelle `sauvegarder_mls_et_persister` (Tauri) → Argon2id. | 🔄 À MIGRER | ✅ Oui — §3.4 |
| 24 | [`hex.ts:116-117`](frontend/src/lib/utils/hex.ts:116) | `saveMlsStateEncrypted(userId, bytes)` | Persiste le checkpoint MLS Argon2+ChaCha20. | 🔄 À MIGRER | ✅ Oui — via `saveState` |

### 1.5 Couche Tauri Rust — Commandes

| # | Fichier:ligne | Fonction | Rôle Argon2id | Statut | Couvert par le plan ? |
|---|---|---|---|---|---|
| 25 | [`mls.rs:15-47`](frontend/src-tauri/src/commands/mls.rs:15) | `initialiser_mls(userId, deviceId, pin: String, state?)` | Appelle `MlsManager::load_encrypted_owned` → Argon2id. | 🔄 À MIGRER | ✅ Oui — §4.7, nouvelle commande `initialiser_mls_avec_clef` |
| 26 | [`mls.rs:48-68`](frontend/src-tauri/src/commands/mls.rs:48) | `sauvegarder_mls(pin: String, state)` | Appelle `save_encrypted_owned` → Argon2id. | 🔄 À MIGRER | ✅ Oui — §3.1, `sauvegarder_mls_avec_clef` |
| 27 | [`mls.rs:70-103`](frontend/src-tauri/src/commands/mls.rs:70) | `sauvegarder_mls_et_persister(pin: String, state)` | `save_encrypted_owned` + écriture fichier. | 🔄 À MIGRER | ✅ Oui — §4.7 |
| 28 | [`mls.rs:704-731`](frontend/src-tauri/src/commands/mls.rs:704) | `actualiser_cle_keystore(pin: String, userId, deviceId)` | **Argon2id via `derive_and_store_device_key`**. Met à jour le keystore après changePIN. | 🔄 À MIGRER | ⚠️ **Plan incomplet** — le plan mentionne `changeDeviceKey` mais ne détaille pas le remplacement de cette commande. Il faut une version `actualiser_cle_keystore_avec_devicekey` ou faire dériver `newDeviceKeyB64` côté frontend avant l'appel. |
| 29 | [`push.rs:309-357`](frontend/src-tauri/src/commands/push.rs:309) | `store_push_context(pin: String, userId, deviceId, ...)` | **Argon2id via `derive_and_store_device_key`**. Dérive `deviceKeyB64` et l'écrit dans `push_context.json`. | ✅ DÉJÀ MIGRÉ | ✅ Oui — §3.9, déjà OK. Le plan conserve cette commande pour le premier login. |
| 30 | [`bootstrap.rs:60-62`](frontend/src-tauri/src/commands/bootstrap.rs:60) | (init) `pin: String` | Transmet le PIN aux commandes MLS. | 🔄 À MIGRER | ⚠️ **Plan incomplet** — le plan ne mentionne pas `bootstrap.rs`. Si ce fichier initialise le MLS avec le PIN, il doit aussi être migré. |
| 31 | [`storage.rs:27-41`](frontend/src-tauri/src/commands/storage.rs:27) | `load_encrypted` mentionné | Commentaire "Argon2" dans le contexte de lecture de `mls.bin`. | 🔄 À MIGRER | ✅ Oui — la migration de `load_encrypted` couvre ceci |

### 1.6 Couche Kotlin/Android — Background Push

| # | Fichier:ligne | Fonction | Rôle Argon2id | Statut | Couvert par le plan ? |
|---|---|---|---|---|---|
| 32 | [`MlsBackgroundWorker.kt:58`](frontend/src-tauri/gen/android/app/src/main/java/fr/emse/canari/MlsBackgroundWorker.kt:58) | `nativeProcessBackgroundTasks(filesDir, stateBytes, pin: String, userId, deviceId)` | **JNI bridge** — le paramètre `pin` est passé comme `""` (ligne 124). Le code Rust derrière utilise `load_encrypted` qui tente Argon2id avec PIN vide. | 🔄 À MIGRER | ⚠️ **Plan incomplet** — Le worker passe déjà `""` comme PIN, mais le JNI côté Rust doit être migré pour utiliser `deviceKeyB64`. Le plan ne mentionne pas le JNI `nativeProcessBackgroundTasks`. |
| 33 | [`CanariFirebaseMessagingService.kt:662-663`](frontend/src-tauri/gen/android/app/src/main/java/fr/emse/canari/CanariFirebaseMessagingService.kt:662) | Commentaire | "The 32-byte device key (base64) from push_context.json replaces the PIN string for all background MLS decryption." | ✅ DÉJÀ MIGRÉ | ✅ Oui — le commentaire confirme que le background utilise déjà `deviceKeyB64` |
| 34 | [`CanariFirebaseMessagingService.kt:1199`](frontend/src-tauri/gen/android/app/src/main/java/fr/emse/canari/CanariFirebaseMessagingService.kt:1199) | `processWelcome` (commentaire) | "mls.bin read + Argon2 decryption + add_member + mls.bin write ~5-8s" | 🔄 À MIGRER | ⚠️ **Plan incomplet** — Le commentaire mentionne encore "Argon2 decryption" dans le chemin Welcome. Si le Welcome passe par le JNI avec `deviceKeyB64`, le commentaire est obsolète. Si non, c'est un chemin non migré. |
| 35 | [`CanariFirebaseMessagingService.kt:1421-1422`](frontend/src-tauri/gen/android/app/src/main/java/fr/emse/canari/CanariFirebaseMessagingService.kt:1421) | `tryDecrypt` (commentaire) | "The lock is acquired ONLY for mls.bin access and the JNI Argon2" | 🔄 À MIGRER | ⚠️ **Plan incomplet** — Le commentaire mentionne "JNI Argon2". Si le JNI utilise déjà `deviceKeyB64` (variantes `_with_key`), le commentaire est obsolète. |
| 36 | [`CanariFirebaseMessagingService.kt:1450`](frontend/src-tauri/gen/android/app/src/main/java/fr/emse/canari/CanariFirebaseMessagingService.kt:1450) | `tryDecrypt` (commentaire) | "mls.bin + Argon2/JNI (~3-5s max)" | 🔄 À MIGRER | ⚠️ Même remarque — le commentaire mentionne Argon2 mais le code utilise probablement déjà `decrypt_with_key`. |

### 1.7 Couche Rust — Background Mobile

| # | Fichier:ligne | Fonction | Rôle Argon2id | Statut | Couvert par le plan ? |
|---|---|---|---|---|---|
| 37 | [`background.rs:353`](frontend/src-tauri/src/mobile/background.rs:353) | Commentaire | "load_encrypted calls security::derive_key_from_pin(pin, salt) then decrypt_blob" — mais le code utilise ensuite `decrypt_with_raw_key`. | ✅ DÉJÀ MIGRÉ | ✅ Oui — §3.9, le background utilise déjà `_with_key` |
| 38 | [`background.rs:360`](frontend/src-tauri/src/mobile/background.rs:360) | `decrypt_with_raw_key(state_bytes, key, ...)` | **Sans Argon2id** — clé 32B directe. | ✅ DÉJÀ MIGRÉ | ✅ Oui |
| 39 | [`background.rs:400-423`](frontend/src-tauri/src/mobile/background.rs:400) | `background_group_epoch_with_key(state_bytes, key_b64: &str, ...)` | **Sans Argon2id** — décode base64 → `decrypt_blob`. | ✅ DÉJÀ MIGRÉ | ✅ Oui |
| 40 | [`background.rs:426`](frontend/src-tauri/src/mobile/background.rs:426) | `decrypt_push_message_with_commits_with_key(state_bytes, key_b64: &str, ...)` | **Sans Argon2id** — décode base64 → `decrypt_blob`. | ✅ DÉJÀ MIGRÉ | ✅ Oui |

### 1.8 Couche TypeScript — Backup

| # | Fichier:ligne | Fonction | Rôle Argon2id | Statut | Couvert par le plan ? |
|---|---|---|---|---|---|
| 41 | [`backup.ts:121`](frontend/src/lib/backup.ts:121) | `exportBackup(...)` | Appelle WASM `encrypt_with_pin` → **Argon2id + ChaCha20**. Chiffre le blob de backup. | 🔄 À MIGRER | ⚠️ **Plan incomplet** — Le plan ne mentionne PAS `backup.ts`. Le backup devra utiliser `encrypt_with_key(deviceKeyB64, data)` après migration. |
| 42 | [`backup.ts:172`](frontend/src/lib/backup.ts:172) | `importBackup(...)` | Appelle WASM `decrypt_with_pin` → **Argon2id**. Déchiffre le blob de backup. | 🔄 À MIGRER | ⚠️ **Plan incomplet** — Même remarque. |

---

## Partie 2 — PBKDF2

### 2.1 Chiffrement des messages locaux

| # | Fichier:ligne | Fonction | Rôle PBKDF2 | Statut | Couvert par le plan ? |
|---|---|---|---|---|---|
| 43 | [`encryption.ts:11`](frontend/src/lib/encryption.ts:11) | `PBKDF2_ITERATIONS = 100_000` | Constante d'itérations PBKDF2. | ❌ À SUPPRIMER | ✅ Oui — §5.1 |
| 44 | [`encryption.ts:23-51`](frontend/src/lib/encryption.ts:23) | `deriveKey(pin: string, salt: Uint8Array) -> CryptoKey` | **PBKDF2-HMAC-SHA256 → clé AES-256-GCM**. Avec cache par `pin:salt`. | ❌ À SUPPRIMER | ✅ Oui — §5.1, remplacée par `importDeviceKey` |
| 45 | [`encryption.ts:60-71`](frontend/src/lib/encryption.ts:60) | `encryptData(data, pin: string, stableSalt?) -> {iv, salt, ciphertext}` | **PBKDF2 + AES-256-GCM**. Format `[salt 16][iv 12][ciphertext]`. | 🔄 À MIGRER | ✅ Oui — §3.3, conservée en `@deprecated` temporairement |
| 46 | [`encryption.ts:79-96`](frontend/src/lib/encryption.ts:79) | `decryptData(ciphertext, iv, salt, pin: string)` | **PBKDF2 + AES-256-GCM** déchiffrement. | 🔄 À MIGRER | ✅ Oui — §3.3, conservée en `@deprecated` temporairement |

### 2.2 Vérificateur de PIN serveur

| # | Fichier:ligne | Fonction | Rôle PBKDF2 | Statut | Couvert par le plan ? |
|---|---|---|---|---|---|
| 47 | [`auth.ts:11-33`](frontend/src/lib/utils/chat/auth.ts:11) | `computePinVerifier(uid, userPin: string, salt: string) -> string` | **PBKDF2-SHA256 (100K itérations)** pour dériver le vérificateur de PIN envoyé au serveur (`pin-check`, `pin-reset`, `pin-change`). | 🛡️ **CONSERVÉ** | ✅ Oui — le plan précise que le PIN reste nécessaire pour l'authentification serveur. Cette fonction fait partie du protocole d'auth, pas du chiffrement local. |

### 2.3 Coffre-fort de documents (associations)

| # | Fichier:ligne | Fonction | Rôle PBKDF2 | Statut | Couvert par le plan ? |
|---|---|---|---|---|---|
| 48 | [`vaultCrypto.ts:13`](frontend/src/lib/associations/vaultCrypto.ts:13) | `PBKDF2_ITERATIONS = 210_000` | Constante pour les documents protégés par mot de passe. | 🛡️ **HORS SCOPE** | ✅ Le plan ne le mentionne pas — et c'est correct. Ce PBKDF2 est pour les mots de passe de documents du vault associatif, pas pour le PIN utilisateur. |
| 49 | [`vaultCrypto.ts:49-85`](frontend/src/lib/associations/vaultCrypto.ts:49) | `deriveDocumentCekWithPassword(vaultKeyHex, docId, password: string, pwSaltHex)` | **PBKDF2(password, pwSalt) → 256 bits → HKDF → CEK**. Double protection : vaultKey + password. | 🛡️ **HORS SCOPE** | Même raison. |

### 2.4 Infrastructure

| # | Fichier:ligne | Fonction | Rôle PBKDF2 | Statut | Couvert par le plan ? |
|---|---|---|---|---|---|
| 50 | [`salt.ts:7-28`](frontend/src/lib/db/salt.ts:7) | `getOrCreateEncryptionSalt(storageId)` | Génère/persiste un sel stable pour PBKDF2 (cache de dérivation). | ❌ À SUPPRIMER | ✅ Oui — §3.5 |
| 51 | [`types.ts:65-67`](frontend/src/lib/db/types.ts:65) | `EncryptedMessageRow.salt: Uint8Array` | Colonne `salt` dans les rows de messages chiffrés. | ❌ À SUPPRIMER | ✅ Oui — §3.5 |
| 52 | [`indexeddb.ts:70-72`](frontend/src/lib/db/indexeddb.ts:70) | Migration v3→v4 | Commentaire "Encryption format changed from Argon2+ChaCha20 (WASM) to PBKDF2+AES-GCM" | ℹ️ Historique | ✅ Oui — le bump v5→v6 est prévu |
| 53 | [`sqlite.ts:175-176`](frontend/src/lib/db/sqlite.ts:175) | Migration | Même commentaire historique. | ℹ️ Historique | ✅ Oui |

---

## Partie 3 — PIN en clair (paramètres `pin: string` et stockage)

### 3.1 PinVault (stockage du PIN)

| # | Fichier:ligne | Fonction | Rôle | Statut | Couvert par le plan ? |
|---|---|---|---|---|---|
| 54 | [`pinVault.ts:75-84`](frontend/src/lib/utils/pinVault.ts:75) | `savePin(pin: string)` | AES-GCM chiffre le PIN → sessionStorage/localStorage. | 🔄 À MIGRER | ✅ Oui — §3.3, renommée `saveDeviceKey` |
| 55 | [`pinVault.ts:91-112`](frontend/src/lib/utils/pinVault.ts:91) | `loadPin() -> string|null` | Déchiffre et retourne le PIN stocké. | 🔄 À MIGRER | ✅ Oui — §3.3, renommée `loadDeviceKey` |
| 56 | [`pinVault.ts:123-131`](frontend/src/lib/utils/pinVault.ts:123) | `setPinPersistence(enabled: boolean, pin: string|null)` | Change le storage backend + re-sauvegarde. | 🔄 À MIGRER | ✅ Oui — §3.3, renommée `setDeviceKeyPersistence` |
| 57 | [`pinVault.ts:134-137`](frontend/src/lib/utils/pinVault.ts:134) | `clearPin()` | Efface le blob PIN des deux storages. | 🔄 À MIGRER | ✅ Oui — §3.3, renommée `clearDeviceKey` |
| 58 | [`pinVault.ts:140-145`](frontend/src/lib/utils/pinVault.ts:140) | `clearPinAndKey()` | Efface blob + wrap key. | 🔄 À MIGRER | ✅ Oui — §3.3, renommée `clearDeviceKeyAndWrapKey` |
| 59 | [`pinVault.ts:37-43`](frontend/src/lib/utils/pinVault.ts:37) | `isPinPersistenceEnabled() -> boolean` | Vérifie le flag de persistance. | 🔄 À MIGRER | ✅ Oui — §3.3, renommée |

### 3.2 Session — Composable (flux de login)

| # | Fichier:ligne | Fonction | Rôle | Statut | Couvert par le plan ? |
|---|---|---|---|---|---|
| 60 | [`sessionAuth.ts`](frontend/src/lib/composables/session/sessionAuth.ts) | `makeRecoveryDeps` | `pin: ctx.getPin()` → passé aux fonctions de recovery. | 🔄 À MIGRER | ✅ Oui — §3.6 (`ctx.getDeviceKey()`) |
| 61 | [`sessionAuth.ts`](frontend/src/lib/composables/session/sessionAuth.ts) | `makeOutboxDeps` | `pin: ctx.getPin()` → passé au flusher d'outbox. | 🔄 À MIGRER | ✅ Oui |
| 62 | [`sessionAuth.ts`](frontend/src/lib/composables/session/sessionAuth.ts) | `setupMessageHandler` | `pin: ctx.getPin()` → handler de messages. | 🔄 À MIGRER | ✅ Oui |
| 63 | [`sessionAuth.ts`](frontend/src/lib/composables/session/sessionAuth.ts) | `handleWelcomeRequest` | `pin: ctx.getPin()` → chiffrement. | 🔄 À MIGRER | ✅ Oui |
| 64 | [`sessionAuth.ts`](frontend/src/lib/composables/session/sessionAuth.ts) | `handleHistoryRequest` | `pin: ctx.getPin()` → chiffrement. | 🔄 À MIGRER | ✅ Oui |
| 65 | [`sessionAuth.ts`](frontend/src/lib/composables/session/sessionAuth.ts) | `initializeConnection` | `pin: ctx.getPin()` → connexion WebSocket. | 🛡️ **CONSERVÉ** | ✅ Oui — le plan note que cet usage est pour l'auth, pas le chiffrement |
| 66 | [`sessionAuth.ts`](frontend/src/lib/composables/session/sessionAuth.ts) | `loginImpl` | `savePin(ctx.getPin())` → stockage PIN dans PinVault après login. | 🔄 À MIGRER | ✅ Oui — §3.6, devient `saveDeviceKey(deviceKeyB64)` |
| 67 | [`sessionAuth.ts`](frontend/src/lib/composables/session/sessionAuth.ts) | `nativeStorageLoginImpl` | `loadPin()` → récupération PIN depuis PinVault. | 🔄 À MIGRER | ✅ Oui — devient `loadDeviceKey()` |
| 68 | [`sessionAuth.ts`](frontend/src/lib/composables/session/sessionAuth.ts) | `recoverPinImpl` | PIN utilisé pour la recovery. | 🔄 À MIGRER | ✅ Oui — devient `recoverDeviceKeyImpl` |
| 69 | [`sessionBiometrics.ts:75`](frontend/src/lib/composables/session/sessionBiometrics.ts:75) | `enrollBiometricImpl` | `clearPinAndKey()` — efface le PIN après enrollment biométrique. | 🔄 À MIGRER | ✅ Oui — §3.6, devient `clearDeviceKeyAndWrapKey()` |
| 70 | [`sessionBiometrics.ts:77-78`](frontend/src/lib/composables/session/sessionBiometrics.ts:77) | `enrollBiometricImpl` | `setPinPersistence(false, null)`. | 🔄 À MIGRER | ✅ Oui |
| 71 | [`sessionBiometrics.ts:109`](frontend/src/lib/composables/session/sessionBiometrics.ts:109) | `disableBiometricImpl` | `savePin(pin)` — re-sauvegarde le PIN après désactivation biométrie. | 🔄 À MIGRER | ✅ Oui — devient `saveDeviceKey(ctx.getDeviceKey())` |

### 3.3 Session — Etat global

| # | Fichier:ligne | Fonction | Rôle | Statut | Couvert par le plan ? |
|---|---|---|---|---|---|
| 72 | [`ChatBackgroundService.svelte:788`](frontend/src/lib/components/layout/ChatBackgroundService.svelte:788) | Assignation | `globalSession.pin = savedPin` — stocke le PIN dans la session globale. | 🔄 À MIGRER | ⚠️ **Plan incomplet** — La session globale doit aussi stocker `deviceKeyB64`. Le plan mentionne `sessionTypes.ts` mais pas `ChatBackgroundService.svelte`. |
| 73 | [`ChatBackgroundService.svelte:871-891`](frontend/src/lib/components/layout/ChatBackgroundService.svelte:871) | Reprise post-background | `const { pin, storage } = globalSession` → utilisé pour `flushFcmCache(pin, storage)`. | 🔄 À MIGRER | ⚠️ **Plan incomplet** — Ces appels doivent utiliser `deviceKeyB64` au lieu de `pin`. |
| 74 | [`ChatBackgroundService.svelte:909-913`](frontend/src/lib/components/layout/ChatBackgroundService.svelte:909) | Timer FCM | `const { pin, storage } = globalSession` → `flushFcmCache(pin, storage)`. | 🔄 À MIGRER | ⚠️ **Plan incomplet** |
| 75 | [`ChatBackgroundService.svelte:982-983`](frontend/src/lib/components/layout/ChatBackgroundService.svelte:982) | Login | `globalSession.pin = submittedPin` — stocke le PIN saisi. | 🔄 À MIGRER | ⚠️ **Plan incomplet** |
| 76 | [`MainChatPage.svelte:163`](frontend/src/lib/components/MainChatPage.svelte:163) | Passage de props | `pin: session.pin` → passé aux composants enfants. | 🔄 À MIGRER | ✅ Oui — suivra le renommage de `session.pin` → `session.deviceKeyB64` |
| 77 | [`MainChatPage.svelte:420`](frontend/src/lib/components/MainChatPage.svelte:420) | Création conversation | `pin: session.pin`. | 🔄 À MIGRER | ✅ Oui |
| 78 | [`MainChatPage.svelte:627`](frontend/src/lib/components/MainChatPage.svelte:627) | `getMessages` | `session.storage.getMessages(conversationId, session.pin)`. | 🔄 À MIGRER | ✅ Oui |
| 79 | [`SettingsSecuritySection.svelte:60`](frontend/src/lib/components/settings/SettingsSecuritySection.svelte:60) | Toggle "stay signed in" | `setPinPersistence(next, session.pin || null)`. | 🔄 À MIGRER | ✅ Oui |
| 80 | [`SettingsSecuritySection.svelte:113`](frontend/src/lib/components/settings/SettingsSecuritySection.svelte:113) | ChangePIN | `setPin: (p: string) => (session.pin = p)`. | 🔄 À MIGRER | ✅ Oui |
| 81 | [`SettingsSyncSection.svelte:22`](frontend/src/lib/components/settings/SettingsSyncSection.svelte:22) | Sync | `pin: session.pin`. | 🔄 À MIGRER | ✅ Oui |

### 3.4 Fonctions métier — PIN passé en paramètre

| # | Fichier:ligne | Fonction | Rôle | Statut | Couvert par le plan ? |
|---|---|---|---|---|---|
| 82 | [`IMlsService.ts:74`](frontend/src/lib/mls-client/IMlsService.ts:74) | `init(userId: string, pin: string, state?)` | Signature abstraite. | 🔄 À MIGRER | ✅ Oui — §3.4 |
| 83 | [`IMlsService.ts:82`](frontend/src/lib/mls-client/IMlsService.ts:82) | `saveState(pin: string): Promise<Uint8Array>` | Signature abstraite. | 🔄 À MIGRER | ✅ Oui |
| 84 | [`IMlsService.ts:110`](frontend/src/lib/mls-client/IMlsService.ts:110) | `generateKeyPackage(pin: string)` | Signature abstraite. | 🔄 À MIGRER | ✅ Oui |
| 85 | [`IMlsService.ts:119`](frontend/src/lib/mls-client/IMlsService.ts:119) | `republishKeyMaterial(pin: string)` | Signature abstraite. | 🔄 À MIGRER | ✅ Oui |
| 86 | [`BaseMlsService.ts:147-149`](frontend/src/lib/services/BaseMlsService.ts:147) | `_initImpl(userId, pin, state?, opts?)` | Signature abstraite. | 🔄 À MIGRER | ✅ Oui |
| 87 | [`BaseMlsService.ts:167-169`](frontend/src/lib/services/BaseMlsService.ts:167) | `_initImpl` deuxième surcharge. | 🔄 À MIGRER | ✅ Oui |
| 88 | [`BaseMlsService.ts:179`](frontend/src/lib/services/BaseMlsService.ts:179) | `loadStateWithPin(pin: string, state?)` | Signature abstraite. | 🔄 À MIGRER | ✅ Oui |
| 89 | [`BaseMlsService.ts:686`](frontend/src/lib/services/BaseMlsService.ts:686) | `republishKeyMaterial(pin: string)` | Implémentation. | 🔄 À MIGRER | ✅ Oui |
| 90 | [`BaseMlsService.ts:933-934`](frontend/src/lib/services/BaseMlsService.ts:933) | `abstract changePIN(newPin: string)` | Signature abstraite. | 🔄 À MIGRER | ✅ Oui — devient `changeDeviceKey` |
| 91 | [`WebMlsService.ts:530`](frontend/src/lib/services/WebMlsService.ts:530) | `init(userId, pin, state?)` | Implémentation. | 🔄 À MIGRER | ✅ Oui |
| 92 | [`WebMlsService.ts:537-538`](frontend/src/lib/services/WebMlsService.ts:537) | `_initImpl(userId, pin, state?, opts?)` | Implémentation. | 🔄 À MIGRER | ✅ Oui |
| 93 | [`WebMlsService.ts:641`](frontend/src/lib/services/WebMlsService.ts:641) | `generateKeyPackage(pin: string)` | Implémentation. | 🔄 À MIGRER | ✅ Oui |
| 94 | [`TauriMlsService.ts:48`](frontend/src/lib/services/TauriMlsService.ts:48) | `private _pin = ''` | Stockage du PIN en mémoire. | 🔄 À MIGRER | ✅ Oui — devient `_deviceKeyB64` |
| 95 | [`TauriMlsService.ts:364`](frontend/src/lib/services/TauriMlsService.ts:364) | `init(userId, pin, state?)` | Implémentation. | 🔄 À MIGRER | ✅ Oui |
| 96 | [`TauriMlsService.ts:387-389`](frontend/src/lib/services/TauriMlsService.ts:387) | `_initImpl(userId, pin, state?, opts?)` | Implémentation. | 🔄 À MIGRER | ✅ Oui |
| 97 | [`TauriMlsService.ts:594`](frontend/src/lib/services/TauriMlsService.ts:594) | `generateKeyPackage(pin: string)` | Implémentation. | 🔄 À MIGRER | ✅ Oui |
| 98 | [`keyPackages.ts:10`](frontend/src/lib/mls-client/keyPackages.ts:10) | `replenishKeyPackages(mlsService, pin: string)` | Délégue à `mlsService.generateKeyPackage(pin)`. | 🔄 À MIGRER | ✅ Oui |

### 3.5 Fonctions de chat — PIN passé en paramètre

| # | Fichier:ligne | Fonction | Rôle | Statut | Couvert par le plan ? |
|---|---|---|---|---|---|
| 99 | [`conversations.ts:350-352`](frontend/src/lib/utils/chat/conversations.ts:350) | `createConversation(userId, pin: string, storage, ...)` | Passe `pin` au stockage. | 🔄 À MIGRER | ✅ Oui — §3.8 |
| 100 | [`actions.ts:39-41`](frontend/src/lib/utils/chat/actions.ts:39) | `processPendingInvitations(userId, pin: string, ...)` | Passe `pin` aux opérations MLS. | 🔄 À MIGRER | ✅ Oui — §3.8 |
| 101 | [`actions.ts:293-294`](frontend/src/lib/utils/chat/actions.ts:293) | Autre fonction avec `pin: string` | Idem. | 🔄 À MIGRER | ✅ Oui |
| 102 | [`actions.ts:528-530`](frontend/src/lib/utils/chat/actions.ts:528) | Autre fonction avec `pin: string` | Idem. | 🔄 À MIGRER | ✅ Oui |
| 103 | [`actions.ts:577-578`](frontend/src/lib/utils/chat/actions.ts:577) | Envoi de fichier avec `pin: string` | Chiffrement média. | 🔄 À MIGRER | ⚠️ **Plan incomplet** — L'envoi de fichier utilise le PIN pour le chiffrement du média. Doit passer à `deviceKeyB64`. |
| 104 | [`actions.ts:622`](frontend/src/lib/utils/chat/actions.ts:622) | `generateDevKeyPackage(mlsService, pin: string)` | Dev helper. | 🔄 À MIGRER | ✅ Oui |
| 105 | [`actions.ts:700-702`](frontend/src/lib/utils/chat/actions.ts:700) | `removeFromGroup` | `pin: string`. | 🔄 À MIGRER | ✅ Oui |
| 106 | [`actions.ts:955-957`](frontend/src/lib/utils/chat/actions.ts:955) | `leaveGroup` | `pin: string`. | 🔄 À MIGRER | ✅ Oui |
| 107 | [`groupActions.ts:97-99`](frontend/src/lib/utils/chat/groupActions.ts:97) | Fonctions de gestion de groupe | `pin: string`. | 🔄 À MIGRER | ✅ Oui — §3.8 |
| 108 | [`groupActions.ts:146-148`](frontend/src/lib/utils/chat/groupActions.ts:146) | Idem | Idem. | 🔄 À MIGRER | ✅ Oui |
| 109 | [`groupActions.ts:169-170`](frontend/src/lib/utils/chat/groupActions.ts:169) | Idem | Idem. | 🔄 À MIGRER | ✅ Oui |
| 110 | [`groupActions.ts:221-222`](frontend/src/lib/utils/chat/groupActions.ts:221) | Idem | Idem. | 🔄 À MIGRER | ✅ Oui |
| 111 | [`groupActions.ts:257-259`](frontend/src/lib/utils/chat/groupActions.ts:257) | Idem | Idem. | 🔄 À MIGRER | ✅ Oui |
| 112 | [`groupActions.ts:288-289`](frontend/src/lib/utils/chat/groupActions.ts:288) | Idem | Idem. | 🔄 À MIGRER | ✅ Oui |
| 113 | [`groupActions.ts:347-348`](frontend/src/lib/utils/chat/groupActions.ts:347) | Idem | Idem. | 🔄 À MIGRER | ✅ Oui |
| 114 | [`groupActions.ts:391-392`](frontend/src/lib/utils/chat/groupActions.ts:391) | Idem | Idem. | 🔄 À MIGRER | ✅ Oui |
| 115 | [`groupActions.ts:463-464`](frontend/src/lib/utils/chat/groupActions.ts:463) | Idem | Idem. | 🔄 À MIGRER | ✅ Oui |
| 116 | [`recovery.ts:42-43`](frontend/src/lib/utils/chat/recovery.ts:42) | `requestReAdd(userId, pin: string, ...)` | Passe `pin` au MLS. | 🔄 À MIGRER | ✅ Oui — §3.8 |
| 117 | [`outbox.ts:57-59`](frontend/src/lib/utils/chat/outbox.ts:57) | `registerOutbox`, `flushOutbox` | `pin: string` pour chiffrement outbox. | 🔄 À MIGRER | ✅ Oui — §3.8 |
| 118 | [`fcmCache.ts:36`](frontend/src/lib/utils/chat/fcmCache.ts:36) | `consumeFcmCache(pin: string, storage)` | Passe `pin` au stockage pour déchiffrement. | 🔄 À MIGRER | ✅ Oui — §3.8 |
| 119 | [`callSystemMessages.ts:16-18`](frontend/src/lib/utils/chat/callSystemMessages.ts:16) | `setCallSystemMessageContext(userId, pin: string, storage)` | Passe `pin` au stockage. | 🔄 À MIGRER | ✅ Oui — §3.8 |
| 120 | [`history.ts:188-189`](frontend/src/lib/utils/chat/history.ts:188) | `fetchAndStoreHistory(userId, pin: string, ...)` | Passe `pin` au stockage pour chiffrement. | 🔄 À MIGRER | ✅ Oui — §3.8 |
| 121 | [`history.ts:629-630`](frontend/src/lib/utils/chat/history.ts:629) | `buildConversationFromDB(conversationId, pin: string)` | Passe `pin` au stockage. | 🔄 À MIGRER | ✅ Oui |
| 122 | [`messaging.ts:159-161`](frontend/src/lib/utils/chat/messaging.ts:159) | `sendMessage` | `pin: string`. | 🔄 À MIGRER | ✅ Oui |
| 123 | [`groupCreation.ts:20-22`](frontend/src/lib/utils/chat/groupCreation.ts:20) | `createGroup` | `pin: string`. | 🔄 À MIGRER | ✅ Oui |
| 124 | [`migration.ts:13-15`](frontend/src/lib/utils/migration.ts:13) | Migration | `pin: string` pour re-chiffrement. | 🔄 À MIGRER | ⚠️ **Plan incomplet** — Le plan mentionne `pinChange.ts` mais pas `migration.ts`. |
| 125 | [`syncEngine.ts:82-83`](frontend/src/lib/sync/syncEngine.ts:82) | Sync | `pin: string` pour le backup sync. | 🔄 À MIGRER | ⚠️ **Plan incomplet** — Le plan ne mentionne pas `syncEngine.ts`. |
| 126 | [`syncEngine.ts:586-588`](frontend/src/lib/sync/syncEngine.ts:586) | Interface Sync | `pin: string` dans les types. | 🔄 À MIGRER | ⚠️ **Plan incomplet** |

### 3.6 Base de données (IStorage)

| # | Fichier:ligne | Fonction | Rôle | Statut | Couvert par le plan ? |
|---|---|---|---|---|---|
| 127 | [`types.ts:165`](frontend/src/lib/db/types.ts:165) | `saveMessage(msg, pin: string)` | Interface IStorage. | 🔄 À MIGRER | ✅ Oui — §3.5 |
| 128 | [`types.ts:167`](frontend/src/lib/db/types.ts:167) | `saveMessages(msgs, pin: string)` | Interface IStorage. | 🔄 À MIGRER | ✅ Oui |
| 129 | [`types.ts:169`](frontend/src/lib/db/types.ts:169) | `getMessages(conversationId, pin: string)` | Interface IStorage. | 🔄 À MIGRER | ✅ Oui |
| 130 | [`types.ts:172-174`](frontend/src/lib/db/types.ts:172) | `getMessagesPage(conversationId, pin: string, ...)` | Interface IStorage. | 🔄 À MIGRER | ✅ Oui |
| 131 | [`types.ts:206`](frontend/src/lib/db/types.ts:206) | `saveOutboxEntry(entry, pin: string)` | Interface IStorage. | 🔄 À MIGRER | ✅ Oui |
| 132 | [`types.ts:208`](frontend/src/lib/db/types.ts:208) | `getOutboxEntries(pin: string)` | Interface IStorage. | 🔄 À MIGRER | ✅ Oui |
| 133 | [`types.ts:210`](frontend/src/lib/db/types.ts:210) | `getOutboxEntriesForConversation(conversationId, pin: string)` | Interface IStorage. | 🔄 À MIGRER | ✅ Oui |
| 134 | [`types.ts:212`](frontend/src/lib/db/types.ts:212) | `updateOutboxEntry(id, patch, pin: string)` | Interface IStorage. | 🔄 À MIGRER | ✅ Oui |
| 135 | [`indexeddb.ts:228`](frontend/src/lib/db/indexeddb.ts:228) | `saveMessage(msg, pin: string)` | Implémentation. | 🔄 À MIGRER | ✅ Oui |
| 136 | [`indexeddb.ts:238`](frontend/src/lib/db/indexeddb.ts:238) | `saveMessages(msgs, pin: string)` | Implémentation. | 🔄 À MIGRER | ✅ Oui |
| 137 | [`indexeddb.ts:277`](frontend/src/lib/db/indexeddb.ts:277) | `getMessages(conversationId, pin: string)` | Implémentation. | 🔄 À MIGRER | ✅ Oui |
| 138 | [`indexeddb.ts:324-326`](frontend/src/lib/db/indexeddb.ts:324) | `getMessagesPage` | Implémentation. | 🔄 À MIGRER | ✅ Oui |
| 139 | [`indexeddb.ts:475`](frontend/src/lib/db/indexeddb.ts:475) | `saveOutboxEntry(entry, pin: string)` | Implémentation. | 🔄 À MIGRER | ✅ Oui |
| 140 | [`indexeddb.ts:489`](frontend/src/lib/db/indexeddb.ts:489) | `getOutboxEntries(pin: string)` | Implémentation. | 🔄 À MIGRER | ✅ Oui |
| 141 | [`indexeddb.ts:502`](frontend/src/lib/db/indexeddb.ts:502) | `getOutboxEntriesForConversation` | Implémentation. | 🔄 À MIGRER | ✅ Oui |
| 142 | [`indexeddb.ts:519`](frontend/src/lib/db/indexeddb.ts:519) | `updateOutboxEntry` | Implémentation. | 🔄 À MIGRER | ✅ Oui |
| 143 | [`sqlite.ts:238`](frontend/src/lib/db/sqlite.ts:238) | `saveMessage(msg, pin: string)` | Implémentation. | 🔄 À MIGRER | ✅ Oui |
| 144 | [`sqlite.ts:247`](frontend/src/lib/db/sqlite.ts:247) | `saveMessages(msgs, pin: string)` | Implémentation. | 🔄 À MIGRER | ✅ Oui |
| 145 | [`sqlite.ts:294`](frontend/src/lib/db/sqlite.ts:294) | `getMessages(conversationId, pin: string)` | Implémentation. | 🔄 À MIGRER | ✅ Oui |
| 146 | [`sqlite.ts:337-339`](frontend/src/lib/db/sqlite.ts:337) | `getMessagesPage` | Implémentation. | 🔄 À MIGRER | ✅ Oui |
| 147 | [`sqlite.ts:467`](frontend/src/lib/db/sqlite.ts:467) | `saveOutboxEntry(entry, pin: string)` | Implémentation. | 🔄 À MIGRER | ✅ Oui |
| 148 | [`sqlite.ts:493`](frontend/src/lib/db/sqlite.ts:493) | `getOutboxEntries(pin: string)` | Implémentation. | 🔄 À MIGRER | ✅ Oui |
| 149 | [`sqlite.ts:505-506`](frontend/src/lib/db/sqlite.ts:505) | `getOutboxEntriesForConversation` | Implémentation. | 🔄 À MIGRER | ✅ Oui |
| 150 | [`sqlite.ts:521`](frontend/src/lib/db/sqlite.ts:521) | `updateOutboxEntry(id, patch, pin: string)` | Implémentation. | 🔄 À MIGRER | ✅ Oui |

### 3.7 Composables

| # | Fichier:ligne | Fonction | Rôle | Statut | Couvert par le plan ? |
|---|---|---|---|---|---|
| 151 | [`useSyncSession.svelte.ts:25`](frontend/src/lib/composables/useSyncSession.svelte.ts:25) | `pin: string` | Stocké dans le composable. | 🔄 À MIGRER | ⚠️ **Plan incomplet** — Le plan ne mentionne pas `useSyncSession`. |
| 152 | [`useMessaging.svelte.ts:71`](frontend/src/lib/composables/useMessaging.svelte.ts:71) | `pin: string` | Stocké dans le composable. | 🔄 À MIGRER | ⚠️ **Plan incomplet** — Le plan ne mentionne pas `useMessaging`. |
| 153 | [`useConversations.svelte.ts:65`](frontend/src/lib/composables/useConversations.svelte.ts:65) | `pin: string` | Stocké dans le composable. | 🔄 À MIGRER | ⚠️ **Plan incomplet** — Le plan ne mentionne pas `useConversations`. |

### 3.8 Workers

| # | Fichier:ligne | Fonction | Rôle | Statut | Couvert par le plan ? |
|---|---|---|---|---|---|
| 154 | [`mlsKeyPackage.worker.ts:21`](frontend/src/lib/workers/mlsKeyPackage.worker.ts:21) | Message au worker | `pin: string` passé au worker. | 🔄 À MIGRER | ⚠️ **Plan incomplet** — Le plan mentionne `mlsWasmLoader.ts` mais pas le worker KeyPackage. |
| 155 | [`mlsEncrypt.worker.ts:16`](frontend/src/lib/workers/mlsEncrypt.worker.ts:16) | Message au worker | `pin: string` passé pour Argon2id off-thread. | 🔄 À MIGRER | ✅ Oui — §3.4 (`encryptMlsStateOffThread`) |

### 3.9 Composants Svelte

| # | Fichier:ligne | Fonction | Rôle | Statut | Couvert par le plan ? |
|---|---|---|---|---|---|
| 156 | [`PinModal.svelte:12`](frontend/src/lib/components/auth/PinModal.svelte:12) | Props | `onSubmit: (pin: string) => void` — transmet le PIN saisi au parent. | 🛡️ **CONSERVÉ** | ✅ Le PIN doit rester pour la saisie utilisateur (premier login, changePIN). C'est le flux normal. |
| 157 | [`PinModal.svelte:67`](frontend/src/lib/components/auth/PinModal.svelte:67) | Etat local | `let pin = $state('')` — stocke le PIN saisi dans le composant. | 🛡️ **CONSERVÉ** | ✅ Usage UI uniquement |
| 158 | [`ChangePinModal.svelte`](frontend/src/lib/components/auth/ChangePinModal.svelte) | Saisie PIN | Formulaire ancien/nouveau PIN. | 🛡️ **CONSERVÉ** | ✅ Usage UI uniquement |

### 3.10 Sync et backup

| # | Fichier:ligne | Fonction | Rôle | Statut | Couvert par le plan ? |
|---|---|---|---|---|---|
| 159 | [`backup.ts:93`](frontend/src/lib/backup.ts:93) | `exportBackup(userId, pin: string, deviceId, ...)` | PIN → WASM `encrypt_with_pin`. | 🔄 À MIGRER | ⚠️ **Oublié** — §1.8 |
| 160 | [`backup.ts:151`](frontend/src/lib/backup.ts:151) | `importBackup(fileData, pin: string, storage)` | PIN → WASM `decrypt_with_pin`. | 🔄 À MIGRER | ⚠️ **Oublié** — §1.8 |
| 161 | [`pinChange.ts:182`](frontend/src/lib/utils/chat/pinChange.ts:182) | `setPin: (pin: string) => void` | Callback pour mettre à jour le PIN en mémoire. | 🔄 À MIGRER | ✅ Oui — §3.7 |
| 162 | [`pinChange.ts`](frontend/src/lib/utils/chat/pinChange.ts) | `performPinChange`, `reencryptLocalMessages` | Tout le flux changePIN. | 🔄 À MIGRER | ✅ Oui — §3.7 |
| 163 | [`pinValidation.ts:3`](frontend/src/lib/utils/chat/pinValidation.ts:3) | `isValidPin(pin: string): boolean` | Validation de format du PIN. | 🛡️ **CONSERVÉ** | ✅ Validation UI, pas de chiffrement |
| 164 | [`initializeConnection.ts:10`](frontend/src/lib/mls-client/initializeConnection.ts:10) | `pin: string` | Passé pour l'initialisation MLS. | 🔄 À MIGRER | ✅ Oui |

### 3.11 Divers

| # | Fichier:ligne | Fonction | Rôle | Statut | Couvert par le plan ? |
|---|---|---|---|---|---|
| 165 | [`messagePipeline/deps.ts:14`](frontend/src/lib/mls-client/messagePipeline/deps.ts:14) | `pin: string` | Pipeline de messages. | 🔄 À MIGRER | ⚠️ **Plan incomplet** — Le plan ne mentionne pas `messagePipeline/deps.ts`. |
| 166 | [`mlsStatePersister.ts:9`](frontend/src/lib/mls-client/mlsStatePersister.ts:9) | `pin: string` | Persistance état MLS. | 🔄 À MIGRER | ✅ Oui — via `saveState` |
| 167 | [`mlsStatePersisterRegistry.ts:40`](frontend/src/lib/mls-client/mlsStatePersisterRegistry.ts:40) | `pin: string` | Registry de persisters. | 🔄 À MIGRER | ✅ Oui |
| 168 | [`mlsEncryptWorkerSession.ts:29-30`](frontend/src/lib/mls-client/mlsEncryptWorkerSession.ts:29) | `encryptOffThread(plain, pin, workerFactory)` | PIN → Argon2id off-thread. | 🔄 À MIGRER | ✅ Oui |

---

## Partie 4 — `deviceKeyB64` (déjà migré)

Ces usages sont **déjà conformes** à l'architecture cible et ne nécessitent aucune modification.

| # | Fichier:ligne | Élément | Description |
|---|---|---|---|
| D1 | [`push.rs:305-357`](frontend/src-tauri/src/commands/push.rs:305) | `store_push_context` | Dérive `deviceKeyB64` depuis le PIN via `derive_and_store_device_key`, stocke dans `push_context.json`. |
| D2 | [`push.rs:25-37`](frontend/src-tauri/src/commands/push.rs:25) | `PushHealth` | Vérifie que `deviceKeyB64` est présent et non vide dans `push_context.json`. |
| D3 | [`push.rs:361-377`](frontend/src-tauri/src/commands/push.rs:361) | `clear_push_context_key` | Efface `deviceKeyB64` de `push_context.json`. |
| D4 | [`keystore_bridge.rs:28-66`](frontend/src-tauri/src/keystore_bridge.rs:28) | `PluginDeviceKeyStore` | Implémente `DeviceKeyStore` pour le keystore Tauri. |
| D5 | [`MlsContextLoader.kt:18-28`](frontend/src-tauri/gen/android/app/src/main/java/fr/emse/canari/MlsContextLoader.kt:18) | `PushContext.deviceKeyB64` | Charge `deviceKeyB64` depuis `push_context.json` pour le background push. |
| D6 | [`MlsContextLoader.kt:50-51`](frontend/src-tauri/gen/android/app/src/main/java/fr/emse/canari/MlsContextLoader.kt:50) | Rétrocompatibilité | Ignore l'ancien champ `pin` dans `push_context.json`. |
| D7 | [`CanariFirebaseMessagingService.kt:662-663`](frontend/src-tauri/gen/android/app/src/main/java/fr/emse/canari/CanariFirebaseMessagingService.kt:662) | Commentaire | Confirme que `deviceKeyB64` remplace le PIN pour le déchiffrement background. |
| D8 | [`background.rs:360-397`](frontend/src-tauri/src/mobile/background.rs:360) | `decrypt_with_raw_key` | Déchiffre `mls.bin` avec la clé 32B décodée de `deviceKeyB64`. |
| D9 | [`background.rs:400-423`](frontend/src-tauri/src/mobile/background.rs:400) | `background_group_epoch_with_key` | Variante key-based. |
| D10 | [`background.rs:426`](frontend/src-tauri/src/mobile/background.rs:426) | `decrypt_push_message_with_commits_with_key` | Variante key-based avec catchup de commits. |
| D11 | [`crypto.rs:39-49`](frontend/mls-core/src/crypto.rs:39) | `save_encrypted_with_key` | Sauvegarde MLS sans Argon2id. |
| D12 | [`crypto.rs:171-191`](frontend/mls-core/src/crypto.rs:171) | `load_with_key` | Chargement MLS sans Argon2id. |
| D13 | [`security.rs:31-42`](frontend/mls-core/src/security.rs:31) | `encrypt_blob(key: &[u8;32], data)` | Chiffrement bas niveau sans KDF. |
| D14 | [`security.rs:44-52`](frontend/mls-core/src/security.rs:44) | `decrypt_blob(key: &[u8;32], data)` | Déchiffrement bas niveau sans KDF. |
| D15 | [`keystore.rs:32-47`](frontend/mls-core/src/keystore.rs:32) | `DeviceKeyStore` trait | Trait pour le stockage de la clé 32B. |
| D16 | [`security.rs:95-112`](frontend/mls-core/src/security.rs:95) | `derive_and_store_device_key` | Dérivation Argon2id unique + stockage keystore. |

---

## Partie 5 — Usages OUBLIÉS par le plan actuel

Ces fichiers/lignes **ne sont pas mentionnés** dans [`plan-remplacement-pin-par-devicekey.md`](plan-remplacement-pin-par-devicekey.md) mais doivent être migrés.

| # | Fichier | Problème | Action requise |
|---|---|---|---|
| O1 | [`backup.ts`](frontend/src/lib/backup.ts) | `exportBackup` et `importBackup` utilisent WASM `encrypt_with_pin`/`decrypt_with_pin` → Argon2id. | Ajouter au plan : remplacer par `encrypt_with_key`/`decrypt_with_key` après migration WASM. |
| O2 | [`bootstrap.rs`](frontend/src-tauri/src/commands/bootstrap.rs) | Accepte `pin: String` en paramètre, le transmet aux commandes MLS. | Ajouter au plan : doit accepter `deviceKeyB64` au lieu de `pin` pour le chemin C4/C5. |
| O3 | [`mls.rs:704-731`](frontend/src-tauri/src/commands/mls.rs:704) — `actualiser_cle_keystore` | Utilise encore `pin: String` pour dériver la nouvelle clé keystore après changePIN. | Ajouter au plan : créer `actualiser_cle_keystore_avec_devicekey` ou faire dériver `newDeviceKeyB64` côté frontend avant l'appel. |
| O4 | [`MlsBackgroundWorker.kt:58`](frontend/src-tauri/gen/android/app/src/main/java/fr/emse/canari/MlsBackgroundWorker.kt:58) | `nativeProcessBackgroundTasks` a un paramètre `pin: String` (passé comme `""`). Le JNI Rust correspondant doit être audité. | Vérifier que le JNI `nativeProcessBackgroundTasks` utilise bien `deviceKeyB64` côté Rust, sinon le migrer. |
| O5 | [`ChatBackgroundService.svelte`](frontend/src/lib/components/layout/ChatBackgroundService.svelte) | Stocke et utilise `globalSession.pin` à plusieurs endroits (reprise, timer FCM, login). | Ajouter `globalSession.deviceKeyB64` et migrer tous les appels de chiffrement. |
| O6 | [`useSyncSession.svelte.ts`](frontend/src/lib/composables/useSyncSession.svelte.ts) | Contient `pin: string` dans son état. | Migrer vers `deviceKeyB64`. |
| O7 | [`useMessaging.svelte.ts`](frontend/src/lib/composables/useMessaging.svelte.ts) | Contient `pin: string` dans son état. | Migrer vers `deviceKeyB64`. |
| O8 | [`useConversations.svelte.ts`](frontend/src/lib/composables/useConversations.svelte.ts) | Contient `pin: string` dans son état. | Migrer vers `deviceKeyB64`. |
| O9 | [`mlsKeyPackage.worker.ts`](frontend/src/lib/workers/mlsKeyPackage.worker.ts) | Message au worker contient `pin: string`. | Migrer vers `deviceKeyB64`. |
| O10 | [`messagePipeline/deps.ts`](frontend/src/lib/mls-client/messagePipeline/deps.ts) | Contient `pin: string`. | Migrer vers `deviceKeyB64`. |
| O11 | [`syncEngine.ts`](frontend/src/lib/sync/syncEngine.ts) | Utilise `pin: string` pour le backup sync. | Migrer vers `deviceKeyB64`. |
| O12 | [`migration.ts`](frontend/src/lib/utils/migration.ts) | Fonctions de migration utilisant `pin: string`. | Migrer vers `deviceKeyB64`. |
| O13 | [`actions.ts:577`](frontend/src/lib/utils/chat/actions.ts:577) | Envoi de fichier avec `pin: string`. | Vérifier si le chiffrement de fichier est concerné (ce n'est pas du stockage local DB, c'est du chiffrement pour upload). |
| O14 | Commentaires Kotlin [`CanariFirebaseMessagingService.kt`](frontend/src-tauri/gen/android/app/src/main/java/fr/emse/canari/CanariFirebaseMessagingService.kt) | Les commentaires mentionnent encore "Argon2 decryption" / "JNI Argon2" aux lignes 1199, 1421, 1450. | Mettre à jour les commentaires si le code utilise déjà `deviceKeyB64`. Si le code utilise encore Argon2id, le migrer. |

---

## Synthèse

| Catégorie | Nombre d'usages |
|---|---|
| ✅ DÉJÀ MIGRÉ (`deviceKeyB64`) | 16 |
| 🔄 À MIGRER (couvert par le plan) | ~120 |
| ⚠️ À MIGRER (oublié du plan) | 14 |
| 🛡️ CONSERVÉ (hors scope) | 11 |
| ❌ À SUPPRIMER | 10 |
| ℹ️ Historique (commentaires) | 2 |
| **TOTAL** | **~173** |

### Fichiers à ajouter au plan

1. [`backup.ts`](frontend/src/lib/backup.ts) — export/import avec WASM `encrypt_with_pin`/`decrypt_with_pin`
2. [`bootstrap.rs`](frontend/src-tauri/src/commands/bootstrap.rs) — commande d'init Tauri
3. [`mls.rs:704`](frontend/src-tauri/src/commands/mls.rs:704) — `actualiser_cle_keystore` (changePIN keystore)
4. [`MlsBackgroundWorker.kt`](frontend/src-tauri/gen/android/app/src/main/java/fr/emse/canari/MlsBackgroundWorker.kt) — JNI `nativeProcessBackgroundTasks`
5. [`ChatBackgroundService.svelte`](frontend/src/lib/components/layout/ChatBackgroundService.svelte) — `globalSession.pin`
6. [`useSyncSession.svelte.ts`](frontend/src/lib/composables/useSyncSession.svelte.ts) — composable
7. [`useMessaging.svelte.ts`](frontend/src/lib/composables/useMessaging.svelte.ts) — composable
8. [`useConversations.svelte.ts`](frontend/src/lib/composables/useConversations.svelte.ts) — composable
9. [`mlsKeyPackage.worker.ts`](frontend/src/lib/workers/mlsKeyPackage.worker.ts) — worker
10. [`messagePipeline/deps.ts`](frontend/src/lib/mls-client/messagePipeline/deps.ts) — pipeline
11. [`syncEngine.ts`](frontend/src/lib/sync/syncEngine.ts) — sync engine
12. [`migration.ts`](frontend/src/lib/utils/migration.ts) — migration util
13. [`actions.ts:577`](frontend/src/lib/utils/chat/actions.ts:577) — envoi de fichier
14. Commentaires Kotlin dans [`CanariFirebaseMessagingService.kt`](frontend/src-tauri/gen/android/app/src/main/java/fr/emse/canari/CanariFirebaseMessagingService.kt) — mise à jour doc
