# Plan d'implémentation : Keystore natif Android/iOS pour la clé de chiffrement MLS

> **Statut** : Plan détaillé — l'implémentation complète est estimée à 2-3 jours et dépasse le cadre d'une session unique.
> **Tâche** : P1b — Intégration Keystore natif pour protéger la clé de chiffrement MLS.
> **Date** : 2026-07-24

---

## 1. Résumé exécutif

Actuellement, la clé de chiffrement de l'état MLS est dérivée du PIN utilisateur via Argon2id **à chaque lancement** (cf. [`frontend/mls-core/src/crypto.rs:33`](frontend/mls-core/src/crypto.rs:33) — `MlsManager::load_encrypted`). La tâche P1b vise à stocker cette clé dérivée dans le Keystore matériel de la plateforme afin que :

1. La clé ne soit re-dérivée qu'au **premier setup** (le PIN n'est saisi qu'une fois)
2. La clé soit protégée par le **Secure Enclave** (iOS) / **TEE/StrongBox** (Android)
3. L'accès à la clé puisse être conditionné à l'**authentification biométrique**

### Workflow cible

```
Premier lancement:
  PIN → Argon2id → clé 32B → stockée Keystore/Keychain → PIN zeroizé

Lancements suivants:
  Récupération clé depuis Keystore/Keychain → déchiffrement état MLS
```

---

## 2. Architecture proposée

### 2.1 Diagramme des composants

```
┌─────────────────────────────────────────────────────────────────┐
│                    mls-core (crate Rust)                         │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  src/keystore.rs  (NOUVEAU)                              │   │
│  │  - trait DeviceKeyStore                                   │   │
│  │  - store_device_key(key: &[u8; 32], alias: &str)         │   │
│  │  - retrieve_device_key(alias: &str) -> Option<[u8; 32]>  │   │
│  │  - Implémentation no-op par défaut (desktop/web)         │   │
│  └──────────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  src/crypto.rs  (MODIFIÉ)                                │   │
│  │  - MlsManager::load_encrypted → tente keystore d'abord   │   │
│  │  - MlsManager::save_encrypted → stocke clé dans keystore │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              ▲
                              │ trait impl (mobile uniquement)
                              │
┌─────────────────────────────────────────────────────────────────┐
│                canari (crate src-tauri)                          │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  src/mobile/keystore_bridge.rs  (NOUVEAU)                │   │
│  │  - Implémente DeviceKeyStore pour mobile                 │   │
│  │  - Android : appelle JNI → KeystorePlugin.kt             │   │
│  │  - iOS     : appelle FFI → canari_native_store/get_key   │   │
│  └──────────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  src/lib.rs  (MODIFIÉ)                                   │   │
│  │  - JNI: Java_fr_emse_canari_KeystoreBridge_nativeStoreKey│   │
│  │  - JNI: Java_fr_emse_canari_KeystoreBridge_nativeGetKey  │   │
│  └──────────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  src/mobile/ios_ffi.rs  (MODIFIÉ)                        │   │
│  │  - FFI: canari_native_store_key                          │   │
│  │  - FFI: canari_native_get_key                            │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              ▲
                              │ plugin bridge / JNI / FFI
                              │
┌─────────────────────────────────────────────────────────────────┐
│              Plateformes natives (Kotlin / Swift)                │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  KeystorePlugin.kt  (MODIFIÉ)                            │   │
│  │  + storeKeyBytes(alias: String, keyBytes: ByteArray)     │   │
│  │  + getKeyBytes(alias: String): ByteArray?                │   │
│  │  + deleteKeyBytes(alias: String)                         │   │
│  └──────────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  KeystorePlugin.swift  (MODIFIÉ)                         │   │
│  │  + storeKey(alias: String, keyBytes: Data)               │   │
│  │  + getKey(alias: String) -> Data?                        │   │
│  │  + deleteKey(alias: String)                              │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 Décision architecturale clé : pourquoi étendre le plugin existant ?

Le plugin [`tauri-plugin-keystore`](frontend/src-tauri/patches/tauri-plugin-keystore/) est déjà intégré et patché. Il gère correctement :

- **Android** : `AndroidKeyStore` + `KeyGenParameterSpec` avec `setUserAuthenticationRequired(true)`
- **iOS** : `SecAccessControlCreateWithFlags` avec `.userPresence` + `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`

Plutôt que de dupliquer la logique d'accès au Keystore dans du code JNI Rust (extrêmement verbeux et fragile), on **étend le plugin natif existant** avec des méthodes dédiées au stockage de clés brutes (`ByteArray`/`Data`), puis on expose ces méthodes via un bridge Rust → Natif.

---

## 3. Plan d'implémentation détaillé

### Étape 1 : Module `keystore` dans `mls-core` (~1h)

**Fichier à créer** : [`frontend/mls-core/src/keystore.rs`](frontend/mls-core/src/keystore.rs)

```rust
//! Platform-agnostic device key storage trait.
//!
//! On desktop/web, the default implementation is a no-op (the PIN is
//! re-derived from Argon2id at each launch). On mobile (Android/iOS),
//! the `canari` crate provides a platform-specific implementation that
//! stores the key in the hardware-backed Keystore/Keychain.

/// Trait for storing/retrieving the 32-byte MLS device encryption key.
pub trait DeviceKeyStore: Send + Sync {
    /// Store a 32-byte key under the given alias.
    fn store_device_key(&self, key: &[u8; 32], alias: &str) -> Result<(), String>;
    /// Retrieve a 32-byte key by alias, or `None` if not found.
    fn retrieve_device_key(&self, alias: &str) -> Option<[u8; 32]>;
    /// Delete a key by alias.
    fn delete_device_key(&self, alias: &str) -> Result<(), String>;
}

/// No-op implementation for desktop/web platforms.
pub struct NoopDeviceKeyStore;

impl DeviceKeyStore for NoopDeviceKeyStore {
    fn store_device_key(&self, _key: &[u8; 32], _alias: &str) -> Result<(), String> {
        Ok(())
    }
    fn retrieve_device_key(&self, _alias: &str) -> Option<[u8; 32]> {
        None
    }
    fn delete_device_key(&self, _alias: &str) -> Result<(), String> {
        Ok(())
    }
}
```

**Fichier à modifier** : [`frontend/mls-core/src/lib.rs`](frontend/mls-core/src/lib.rs)

Ajouter :
```rust
pub mod keystore;
```

**Fichier à modifier** : [`frontend/mls-core/Cargo.toml`](frontend/mls-core/Cargo.toml)

Pas de nouvelles dépendances nécessaires — le trait est pur Rust.

---

### Étape 2 : Extension du plugin Kotlin (`KeystorePlugin.kt`) (~2h)

**Fichier à modifier** : [`frontend/src-tauri/patches/tauri-plugin-keystore/android/src/main/java/KeystorePlugin.kt`](frontend/src-tauri/patches/tauri-plugin-keystore/android/src/main/java/KeystorePlugin.kt)

#### 2.1 Ajout des classes de requête

```kotlin
@InvokeArg
class StoreKeyBytesRequest {
    lateinit var alias: String
    lateinit var keyBytes: String  // base64-encoded
}

@InvokeArg
class GetKeyBytesRequest {
    lateinit var alias: String
}

@InvokeArg
class DeleteKeyBytesRequest {
    lateinit var alias: String
}
```

#### 2.2 Ajout des commandes dans `KeystorePlugin`

```kotlin
@Command
fun storeKeyBytes(invoke: Invoke) {
    val args = invoke.parseArgs(StoreKeyBytesRequest::class.java)
    val keyBytes = Base64.decode(args.keyBytes, Base64.DEFAULT)
    
    // 1. Générer une clé AES-256 par alias dans AndroidKeyStore
    generateKeyForAlias(args.alias)
    
    // 2. Chiffrer les bytes avec la clé keystore
    val cipher = getEncryptionCipherForAlias(args.alias)
    val ciphertext = cipher.doFinal(keyBytes)
    val iv = cipher.iv
    
    // 3. Stocker IV + ciphertext dans SharedPreferences (namespace par alias)
    storeCipherDataForAlias(args.alias, iv, ciphertext)
    
    invoke.resolve()
}

@Command
fun getKeyBytes(invoke: Invoke) {
    val args = invoke.parseArgs(GetKeyBytesRequest::class.java)
    
    // 1. Lire IV + ciphertext depuis SharedPreferences
    val cipherData = readCipherDataForAlias(args.alias)
    if (cipherData == null) {
        invoke.reject("No key found for alias: ${args.alias}", "NOT_FOUND")
        return
    }
    val (iv, ciphertext) = cipherData
    
    // 2. Déchiffrer avec la clé keystore (déclenche biométrie)
    val cipher = getDecryptionCipherForAlias(args.alias, iv)
    
    // 3. Lancer le prompt biométrique
    val executor = ContextCompat.getMainExecutor(activity)
    val biometricPrompt = BiometricPrompt(...)
    biometricPrompt.authenticate(promptInfo, BiometricPrompt.CryptoObject(cipher))
}

@Command
fun deleteKeyBytes(invoke: Invoke) {
    val args = invoke.parseArgs(DeleteKeyBytesRequest::class.java)
    // 1. Supprimer l'entrée AndroidKeyStore
    val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
    keyStore.deleteEntry(args.alias)
    // 2. Supprimer les SharedPreferences
    val prefs = activity.getSharedPreferences("keystore_aliases", Context.MODE_PRIVATE)
    prefs.edit().remove("${args.alias}_iv").remove("${args.alias}_ct").apply()
    invoke.resolve()
}
```

#### 2.3 Méthodes utilitaires (à ajouter dans la classe)

```kotlin
private fun generateKeyForAlias(alias: String) {
    val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
    if (keyStore.containsAlias(alias)) return
    
    val keyGenerator = KeyGenerator.getInstance(
        KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE
    )
    val builder = KeyGenParameterSpec.Builder(
        alias,
        KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
    )
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setUserAuthenticationRequired(true)
        .setUserAuthenticationParameters(
            300,  // 5 minutes timeout pour permit usage sans re-auth
            KeyProperties.AUTH_BIOMETRIC_STRONG
        )
    keyGenerator.init(builder.build())
    keyGenerator.generateKey()
}

private fun storeCipherDataForAlias(alias: String, iv: ByteArray, ct: ByteArray) {
    val prefs = activity.getSharedPreferences("keystore_aliases", Context.MODE_PRIVATE)
    prefs.edit()
        .putString("${alias}_iv", Base64.encodeToString(iv, Base64.DEFAULT))
        .putString("${alias}_ct", Base64.encodeToString(ct, Base64.DEFAULT))
        .apply()
}
```

**Point d'attention** : Le `setUserAuthenticationParameters(300, ...)` définit un timeout de 5 minutes. Pendant ce délai, l'utilisateur peut récupérer la clé sans nouvelle authentification biométrique. C'est important pour l'UX (ne pas demander la biométrie à chaque lancement si l'app a été ouverte récemment).

---

### Étape 3 : Extension du plugin Swift (`KeystorePlugin.swift`) (~2h)

**Fichier à modifier** : [`frontend/src-tauri/patches/tauri-plugin-keystore/ios/Sources/KeystorePlugin.swift`](frontend/src-tauri/patches/tauri-plugin-keystore/ios/Sources/KeystorePlugin.swift)

#### 3.1 Ajout des types de requête

```swift
class StoreKeyBytesRequest: Decodable {
    let alias: String
    let keyBytes: String  // base64
}

class GetKeyBytesRequest: Decodable {
    let alias: String
}
```

#### 3.2 Ajout des méthodes dans `KeystorePlugin`

```swift
/// Stocke une clé brute (32 octets) dans le Keychain sous l'alias donné.
/// Utilise kSecClassKey pour une clé cryptographique native.
@objc public func storeKeyBytes(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(StoreKeyBytesRequest.self)
    guard let keyData = Data(base64Encoded: args.keyBytes) else {
        throw NSError(domain: "KeyStoreError", code: -1,
            userInfo: [NSLocalizedDescriptionKey: "Invalid base64 key bytes"])
    }
    
    var error: Unmanaged<CFError>?
    guard let accessControl = SecAccessControlCreateWithFlags(
        nil,
        kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        .userPresence,
        &error
    ) else {
        throw error!.takeRetainedValue() as Error
    }
    
    // Supprimer l'entrée existante
    let deleteQuery: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: kKeychainService,
        kSecAttrAccount as String: "mls_key_\(args.alias)"
    ]
    SecItemDelete(deleteQuery as CFDictionary)
    
    // Ajouter la nouvelle entrée
    var addQuery: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: kKeychainService,
        kSecAttrAccount as String: "mls_key_\(args.alias)",
        kSecValueData as String: keyData,
        kSecAttrAccessControl as String: accessControl
    ]
    
    let status = SecItemAdd(addQuery as CFDictionary, nil)
    guard status == errSecSuccess else {
        throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
    }
    invoke.resolve()
}

/// Récupère une clé brute par alias. Retourne `{"keyBytes": "<base64>"}`.
@objc public func getKeyBytes(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(GetKeyBytesRequest.self)
    
    let context = LAContext()
    context.localizedReason = "Déverrouillez Canari pour accéder à vos conversations"
    
    var query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: kKeychainService,
        kSecAttrAccount as String: "mls_key_\(args.alias)",
        kSecReturnData as String: true,
        kSecUseAuthenticationContext as String: context,
        kSecUseOperationPrompt as String: "Déverrouiller Canari"
    ]
    
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    
    guard status == errSecSuccess,
          let data = item as? Data else {
        invoke.resolve(["keyBytes": NSNull()])
        return
    }
    
    invoke.resolve(["keyBytes": data.base64EncodedString()])
}
```

**Note** : On utilise `kSecClassGenericPassword` plutôt que `kSecClassKey` car `kSecClassKey` sur iOS est conçu pour les paires de clés asymétriques générées par le Secure Enclave. Pour stocker une clé symétrique AES-256 arbitraire (dérivée d'Argon2id), `kSecClassGenericPassword` est le bon choix. La protection est assurée par `SecAccessControl` avec `.userPresence`.

---

### Étape 4 : Bridge Rust → Natif dans `src-tauri` (~2h30)

#### 4.1 Nouveau module : `keystore_bridge.rs`

**Fichier à créer** : [`frontend/src-tauri/src/mobile/keystore_bridge.rs`](frontend/src-tauri/src/mobile/keystore_bridge.rs)

Ce module fournit l'implémentation de `DeviceKeyStore` pour Android et iOS.

```rust
//! Bridge Rust → Keystore natif (Android KeyStore / iOS Keychain).
//!
//! Implémente `mls_core::keystore::DeviceKeyStore` en appelant les
//! plugins natifs via le mécanisme Tauri mobile plugin.

use mls_core::keystore::DeviceKeyStore;

/// Implémentation mobile qui délègue au plugin natif.
pub struct MobileDeviceKeyStore {
    // Référence vers le handle du plugin keystore Tauri
    // (injectée au setup)
    handle: ???,  // Voir section 4.2 pour le mécanisme exact
}

impl DeviceKeyStore for MobileDeviceKeyStore {
    fn store_device_key(&self, key: &[u8; 32], alias: &str) -> Result<(), String> {
        let key_b64 = base64::engine::general_purpose::STANDARD.encode(key);
        // Appeler le plugin natif storeKeyBytes
        todo!("Appel plugin natif")
    }
    
    fn retrieve_device_key(&self, alias: &str) -> Option<[u8; 32]> {
        // Appeler le plugin natif getKeyBytes
        todo!("Appel plugin natif")
    }
    
    fn delete_device_key(&self, alias: &str) -> Result<(), String> {
        todo!("Appel plugin natif")
    }
}
```

#### 4.2 Mécanisme d'appel du plugin natif depuis Rust

Deux options :

**Option A (recommandée) : Utiliser `PluginHandle::run_mobile_plugin`**

Le [`Keystore`](frontend/src-tauri/patches/tauri-plugin-keystore/src/mobile.rs:28) existant utilise déjà `self.0.run_mobile_plugin("store", payload)`. On peut étendre ce mécanisme :

```rust
// Dans mobile.rs du plugin keystore
impl<R: Runtime> Keystore<R> {
    pub fn store_key_bytes(&self, payload: StoreKeyBytesRequest) -> crate::Result<()> {
        self.0.run_mobile_plugin("storeKeyBytes", payload).map_err(Into::into)
    }
    pub fn get_key_bytes(&self, payload: GetKeyBytesRequest) -> crate::Result<GetKeyBytesResponse> {
        self.0.run_mobile_plugin("getKeyBytes", payload).map_err(Into::into)
    }
}
```

**Option B : JNI/FFI direct (nécessaire pour le chemin background push)**

Pour le déchiffrement en arrière-plan (push notifications), le Tauri plugin system n'est pas disponible (pas de runtime JS). Dans ce cas, on a besoin de fonctions JNI/FFI directes.

Les fonctions JNI dans [`lib.rs`](frontend/src-tauri/src/lib.rs:45) sont appelées **depuis** le code Java/Kotlin. Pour que Rust appelle le Keystore Android, on doit soit :

1. **Appeler les APIs Java `AndroidKeyStore` via JNI depuis Rust** — faisable mais très verbeux (50+ lignes de `env.find_class`, `env.call_static_method`, etc.)
2. **Faire un aller-retour** : Rust expose une JNI function → Kotlin l'appelle, fait le travail Keystore, et rappelle une autre JNI function avec le résultat — complexe et fragile

**Recommandation** : Pour le chemin foreground (normal), utiliser l'Option A (plugin bridge). Pour le chemin background push, l'Option B est nécessaire mais peut être implémentée dans une phase ultérieure (P1c). En attendant, le background push continuera à utiliser le PIN (comportement actuel).

#### 4.3 Ajout au module `mobile/mod.rs`

**Fichier à modifier** : [`frontend/src-tauri/src/mobile/mod.rs`](frontend/src-tauri/src/mobile/mod.rs)

```rust
#[cfg(any(target_os = "android", target_os = "ios"))]
pub mod keystore_bridge;
```

---

### Étape 5 : Intégration dans le flux MLS (~1h30)

#### 5.1 Modification de `mls-core/src/security.rs`

Ajouter une fonction de dérivation avec stockage keystore :

```rust
/// Derives a 32-byte key from a PIN and stores it in the platform keystore.
/// The PIN is zeroized after derivation. Returns the derived key.
pub fn derive_and_store_device_key(
    mut pin: String,
    salt: &[u8],
    alias: &str,
    keystore: &dyn crate::keystore::DeviceKeyStore,
) -> Result<[u8; 32], String> {
    let key = derive_key_from_pin(&pin, salt)?;
    pin.zeroize();
    keystore.store_device_key(&key, alias)?;
    Ok(key)
}
```

#### 5.2 Modification de `mls-core/src/crypto.rs`

Ajouter une méthode `load_encrypted_with_keystore` :

```rust
impl MlsManager {
    /// Loads the MLS manager, trying the keystore first for the decryption key.
    /// Falls back to PIN-based derivation if the keystore is unavailable or empty.
    pub fn load_encrypted_with_keystore(
        user_id: &str,
        device_id: &str,
        encrypted_blob: Option<Vec<u8>>,
        pin: Option<String>,
        keystore: &dyn crate::keystore::DeviceKeyStore,
    ) -> Result<Self, MlsError> {
        let alias = format!("mls_device_key_{user_id}_{device_id}");
        
        // Try keystore first
        if let Some(key) = keystore.retrieve_device_key(&alias) {
            return Self::load_with_key(user_id, device_id, encrypted_blob, &key);
        }
        
        // Fall back to PIN
        match pin {
            Some(pin_str) => Self::load_encrypted_owned(user_id, device_id, encrypted_blob, pin_str),
            None => Err(MlsError::OpenMls("No keystore key and no PIN provided".into())),
        }
    }
    
    /// Internal: load using a pre-derived key (no Argon2 needed).
    fn load_with_key(
        user_id: &str,
        device_id: &str,
        encrypted_blob: Option<Vec<u8>>,
        key: &[u8; 32],
    ) -> Result<Self, MlsError> {
        let decrypted_state = if let Some(blob) = encrypted_blob {
            if blob.len() < 16 { return Err(MlsError::InvalidData); }
            let (_salt, rest) = blob.split_at(16);
            // Avec le keystore, on ignore le salt — la clé est déjà dérivée
            let plain = crate::security::decrypt_blob(key, rest)
                .map_err(|s| MlsError::OpenMls(format!("Decryption: {}", s)))?;
            Some(plain)
        } else {
            None
        };
        Self::load_or_create(user_id, device_id, decrypted_state)
    }
}
```

> **⚠️ Point d'attention** : Actuellement, le format de chiffrement est `[salt (16)] [nonce (12) || ciphertext]`. Le salt est utilisé pour Argon2id. Avec le keystore, on n'a plus besoin du salt (la clé est stockée directement). Il faut soit :
> - (A) Ignorer le salt quand on utilise le keystore (simple, rétrocompatible)
> - (B) Migrer vers un nouveau format sans salt pour les nouveaux chiffrements (plus propre, mais migration nécessaire)
>
> **Recommandation** : Option (A) pour P1b, migration en P2.

#### 5.3 Modification du format de chiffrement (Option A — rétrocompatible)

Ajouter un magic byte ou utiliser un format détectable. Proposition : préfixer le blob par un octet de version.

```
Version 0 (actuel): [0x00] [salt 16] [nonce 12 || ciphertext]
Version 1 (keystore): [0x01] [nonce 12 || ciphertext]   // pas de salt
```

---

### Étape 6 : Commandes Tauri pour le frontend (~1h)

**Fichier à créer ou modifier** : [`frontend/src-tauri/src/commands/storage.rs`](frontend/src-tauri/src/commands/storage.rs)

Ajouter des commandes pour le setup initial et la migration :

```rust
/// Appelé après la première saisie du PIN : dérive la clé, chiffre l'état MLS,
/// et stocke la clé dans le keystore.
#[tauri::command]
pub async fn setup_device_keystore(
    app: tauri::AppHandle,
    pin: String,
    user_id: String,
    device_id: String,
) -> Result<(), String> {
    let alias = format!("mls_device_key_{user_id}_{device_id}");
    
    // 1. Générer un salt aléatoire
    let mut salt = [0u8; 16];
    getrandom::fill(&mut salt).map_err(|e| e.to_string())?;
    
    // 2. Dériver la clé
    let key = mls_core::security::derive_and_store_device_key(
        pin, &salt, &alias,
        &*app.keystore(), // implémente DeviceKeyStore
    )?;
    
    // 3. Stocker le salt pour les futures ré-encryptions
    // (stocké dans le Tauri store ou SharedPreferences)
    
    Ok(())
}

/// Vérifie si une clé est disponible dans le keystore pour cet utilisateur.
#[tauri::command]
pub async fn has_device_key(
    user_id: String,
    device_id: String,
) -> Result<bool, String> {
    // Vérifier si la clé existe dans le keystore
    Ok(false) // placeholder
}
```

---

### Étape 7 : Tests et validation (~2h)

#### 7.1 Tests unitaires `mls-core`

Ajouter des tests dans [`frontend/mls-core/tests/`](frontend/mls-core/tests/) :

```rust
#[test]
fn keystore_noop_returns_none() {
    let ks = mls_core::keystore::NoopDeviceKeyStore;
    assert!(ks.retrieve_device_key("test").is_none());
}

#[test]
fn keystore_noop_store_is_idempotent() {
    let ks = mls_core::keystore::NoopDeviceKeyStore;
    let key = [42u8; 32];
    assert!(ks.store_device_key(&key, "test").is_ok());
    assert!(ks.retrieve_device_key("test").is_none());
}

#[test]
fn load_encrypted_falls_back_to_pin_when_keystore_empty() {
    // Vérifie que le comportement existant est préservé
    let ks = mls_core::keystore::NoopDeviceKeyStore;
    let mut manager = MlsManager::load_or_create("alice", "dev1", None).unwrap();
    manager.create_group("g1".into()).unwrap();
    let blob = manager.save_encrypted("1234").unwrap();
    
    let loaded = MlsManager::load_encrypted_with_keystore(
        "alice", "dev1", Some(blob), Some("1234".into()), &ks
    );
    assert!(loaded.is_ok());
}
```

#### 7.2 Tests existants

Vérifier que les 30 tests MLS existants passent toujours :
```bash
cd frontend/mls-core && cargo test
```

Les tests ne doivent **pas** être modifiés — le comportement desktop (no-op keystore) doit être identique à l'actuel.

---

## 4. Dépendances et prérequis

### 4.1 Nouvelles dépendances Rust

Aucune nouvelle dépendance externe dans `mls-core`. Dans `src-tauri` :

```toml
# Pour la génération de sel dans setup_device_keystore
getrandom = "0.2"
```

### 4.2 Dépendances natives

Aucune — on étend les plugins Kotlin/Swift existants.

---

## 5. Risques et points d'attention

| Risque | Impact | Mitigation |
|--------|--------|------------|
| **Incompatibilité de format** entre l'ancien chiffrement (avec salt Argon2) et le nouveau (sans salt) | Élevé | Utiliser un magic byte de version (0x00 vs 0x01) |
| **Double source de vérité** : clé dans keystore + clé dérivable du PIN | Moyen | Le keystore est la source primaire ; le PIN est le fallback |
| **Background push sans runtime Tauri** : le plugin bridge ne fonctionne pas en arrière-plan | Moyen | Laisser le background push utiliser le PIN (comme actuellement) ; migration en P1c |
| **Timeout biométrique** : 5 min sur Android, pas de timeout natif sur iOS (`.userPresence` = chaque accès) | Faible | Accepter la différence de comportement plateforme |
| **Migration des utilisateurs existants** : ceux qui ont déjà un état MLS chiffré avec PIN | Élevé | Ajouter une commande `migrate_to_keystore` qui déchiffre avec PIN, ré-encrypte avec clé keystore |
| **Suppression de l'app** : le Keystore/Keychain persiste (Android) ou non (iOS) selon la plateforme | Faible | Documenter ; la clé est recouvrable via PIN (fallback) |
| **`kSecClassKey` vs `kSecClassGenericPassword`** : le premier nécessite une `SecKey`, pas un blob arbitraire | Élevé | Utiliser `kSecClassGenericPassword` avec `SecAccessControl` (même niveau de sécurité) |

---

## 6. Chronologie estimée

| Étape | Durée | Dépendances |
|-------|-------|-------------|
| 1. Module `keystore` dans `mls-core` | 1h | Aucune |
| 2. Extension `KeystorePlugin.kt` (Android) | 2h | Étape 1 |
| 3. Extension `KeystorePlugin.swift` (iOS) | 2h | Étape 1 |
| 4. Bridge Rust → Natif | 2h30 | Étapes 2-3 |
| 5. Intégration flux MLS | 1h30 | Étapes 1, 4 |
| 6. Commandes Tauri + frontend | 1h | Étape 5 |
| 7. Tests et validation | 2h | Étape 6 |
| **Total** | **~12h (2-3 jours)** | |

---

## 7. Prochaines étapes après P1b

1. **P1c** : Keystore pour le chemin background push (JNI/FFI direct sans Tauri runtime)
2. **P2** : Migration du format de chiffrement (nouveau magic byte, suppression du salt Argon2 quand keystore est utilisé)
3. **P2** : Rotation de clé (regénération périodique de la clé keystore)
4. **P3** : Intégration avec `tauri-plugin-biometric` pour le flux UX (vérification biométrique avant accès MLS)

---

## 8. Résumé des fichiers impactés

### Fichiers à créer
| Fichier | Description |
|---------|-------------|
| [`frontend/mls-core/src/keystore.rs`](frontend/mls-core/src/keystore.rs) | Trait `DeviceKeyStore` + implémentation no-op |
| [`frontend/src-tauri/src/mobile/keystore_bridge.rs`](frontend/src-tauri/src/mobile/keystore_bridge.rs) | Bridge Rust → plugin natif |

### Fichiers à modifier
| Fichier | Changement |
|---------|------------|
| [`frontend/mls-core/src/lib.rs`](frontend/mls-core/src/lib.rs:1) | Ajouter `pub mod keystore;` |
| [`frontend/mls-core/src/crypto.rs`](frontend/mls-core/src/crypto.rs:1) | Ajouter `load_encrypted_with_keystore`, `load_with_key` |
| [`frontend/mls-core/src/security.rs`](frontend/mls-core/src/security.rs:1) | Ajouter `derive_and_store_device_key` |
| [`frontend/src-tauri/src/mobile/mod.rs`](frontend/src-tauri/src/mobile/mod.rs:1) | Ajouter `pub mod keystore_bridge;` |
| [`frontend/src-tauri/patches/tauri-plugin-keystore/android/src/main/java/KeystorePlugin.kt`](frontend/src-tauri/patches/tauri-plugin-keystore/android/src/main/java/KeystorePlugin.kt) | Ajouter `storeKeyBytes`, `getKeyBytes`, `deleteKeyBytes` |
| [`frontend/src-tauri/patches/tauri-plugin-keystore/ios/Sources/KeystorePlugin.swift`](frontend/src-tauri/patches/tauri-plugin-keystore/ios/Sources/KeystorePlugin.swift) | Ajouter `storeKeyBytes`, `getKeyBytes` |
| [`frontend/src-tauri/patches/tauri-plugin-keystore/src/mobile.rs`](frontend/src-tauri/patches/tauri-plugin-keystore/src/mobile.rs) | Ajouter `store_key_bytes`, `get_key_bytes` au `Keystore` |
| [`frontend/src-tauri/patches/tauri-plugin-keystore/src/models.rs`](frontend/src-tauri/patches/tauri-plugin-keystore/src/models.rs) | Ajouter `StoreKeyBytesRequest`, `GetKeyBytesRequest`, `GetKeyBytesResponse` |
| [`frontend/src-tauri/src/commands/storage.rs`](frontend/src-tauri/src/commands/storage.rs) | Ajouter commandes `setup_device_keystore`, `has_device_key` |
| [`frontend/mls-core/tests/`](frontend/mls-core/tests/) | Ajouter tests keystore no-op |
