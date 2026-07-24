//! Commandes Tauri de stockage : persistance, rechargement, heartbeat, flags.

use crate::concurrency::{mark_foreground_active, mls_bin_write_lock, write_mls_state_blob};
use crate::state::AppState;
use mls_core::MlsManager;
use tauri::Manager;

/// Write an already-encrypted MLS state blob into {app_data_dir}/mls.bin.
/// Accepts the encrypted bytes (as number[] from JS) and writes them verbatim.
/// This is used by the frontend when it already holds an encrypted state and
/// wants to persist it to the native app data directory (avoid WebView eviction).
#[tauri::command]
pub(crate) fn save_mls_state(app: tauri::AppHandle, data: Vec<u8>) -> Result<(), String> {
    write_mls_state_blob(&app, &data)
}

/// C2 : recharge `mls.bin` du disque dans le manager foreground en memoire, sous le verrou global,
/// et marque le foreground actif. Appele au retour premier-plan AVANT toute operation : pendant
/// l'arriere-plan, un moteur JNI (Welcome/send/worker) a pu faire avancer `mls.bin` ; sans ce
/// rechargement le manager chaud est perime et sa prochaine persistance ECRASERAIT l'avancee
/// background (lost-update -> SecretReuse + regression d'epoch). Renvoie `true` si rechargement
/// effectif, `false` si `mls.bin` absent (rien a faire). Android uniquement cote appelant (aucun
/// moteur background sur desktop).
#[tauri::command]
pub(crate) async fn recharger_mls_au_resume(
    user_id: String,
    device_id: String,
    pin: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<bool, String> {
    // Marquer actif AVANT de lire : toute ecriture background en cours finit son ecriture (verrou)
    // puis les suivantes abandonnent -> la lecture ci-dessous capte la derniere avancee background.
    mark_foreground_active();
    let manager_state = state.mls_manager.clone();
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let path = data_dir.join("mls.bin");
        // Lecture du fichier SOUS le verrou (ne pas lire pendant qu'un JNI ecrit). On relache avant
        // le load_encrypted (Argon2) : la garde foreground bloque desormais toute nouvelle ecriture.
        let bytes = {
            let _guard = mls_bin_write_lock()
                .lock()
                .map_err(|_| "mls_bin write lock poisoned".to_string())?;
            match std::fs::read(&path) {
                Ok(b) => Some(b),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
                Err(e) => return Err(format!("read mls.bin: {e}")),
            }
        };
        let Some(bytes) = bytes else {
            log::debug!("[RESUME] mls.bin absent - rien a recharger (C2)");
            return Ok(false);
        };
        let candidate = MlsManager::load_encrypted(&user_id, &device_id, Some(bytes), &pin)
            .map_err(|e| format!("reload mls.bin: {e}"))?;
        let mut lock = manager_state
            .lock()
            .map_err(|_| "Failed to lock state".to_string())?;
        // Epoch-monotonic reload guard (C2): a snapshot must never regress a live group's epoch.
        // If the live manager already holds a group at a higher epoch than the reloaded candidate
        // (e.g. a stale mls.bin), keep the live state rather than clobber it. [[C2]]
        if let Some(current) = lock.as_ref() {
            if !current.reload_is_monotonic(&candidate) {
                log::warn!(
                    "[RESUME] reload refused - mls.bin would regress a live group epoch, keeping live state (C2)"
                );
                return Ok(false);
            }
        }
        *lock = Some(candidate);
        log::debug!("[RESUME] manager foreground recharge depuis mls.bin (C2)");
        Ok(true)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Heartbeat foreground : rafraichit la garde tant que la WebView est visible. Tant qu'elle est
/// fraiche, les moteurs JNI background abandonnent leurs ecritures `mls.bin` (C1/FCM3).
#[tauri::command]
pub(crate) fn mls_foreground_heartbeat() {
    mark_foreground_active();
}

/// Libere la garde foreground (passage en arriere-plan) : autorise immediatement les moteurs JNI
/// a ecrire `mls.bin`. La garde expirerait de toute facon apres FOREGROUND_GRACE_MS ; ceci accelere
/// le cas propre (evenement `hidden` recu) pour ne pas retarder la livraison background.
#[tauri::command]
pub(crate) fn pause_mls_foreground() {
    crate::concurrency::mark_foreground_inactive();
}

#[tauri::command]
pub(crate) fn delete_mls_state(app: tauri::AppHandle) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let path = data_dir.join("mls.bin");
    if path.exists() {
        std::fs::remove_file(path).map_err(|e| e.to_string())
    } else {
        Ok(())
    }
}

/// Lit {app_data_dir}/mls.bin et retourne son contenu chiffre.
/// Retourne None si le fichier n'existe pas (premiere installation).
/// Utilise au demarrage sur mobile quand localStorage est vide (WebView nettoye).
#[tauri::command]
pub(crate) fn load_mls_state(app: tauri::AppHandle) -> Option<Vec<u8>> {
    let data_dir = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(e) => {
            log::warn!("[MLS] app_data_dir() failed: {e}");
            return None;
        }
    };
    let path = data_dir.join("mls.bin");
    match std::fs::read(&path) {
        Ok(b) => Some(b),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => {
            log::warn!("[MLS] read mls.bin: {e}");
            None
        }
    }
}

// Supprime tous les fichiers .db dans le dossier de l'app
#[tauri::command]
pub(crate) fn clear_app_data(app: tauri::AppHandle) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    if data_dir.exists() {
        for entry in std::fs::read_dir(data_dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) == Some("db") {
                std::fs::remove_file(path).map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}

/// Stores a boolean flag in {app_data_dir}/native_flags.json.
/// Used to persist UI flags (e.g. biometric enrollment) outside the WebView
/// storage layer, which MIUI and other aggressive OEMs may clear between sessions.
#[tauri::command]
pub(crate) fn set_native_flag(
    key: String,
    value: bool,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    let path = data_dir.join("native_flags.json");
    let mut flags: serde_json::Map<String, serde_json::Value> = if path.exists() {
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        serde_json::from_slice(&bytes).unwrap_or_default()
    } else {
        serde_json::Map::new()
    };
    flags.insert(key, serde_json::Value::Bool(value));
    std::fs::write(&path, serde_json::Value::Object(flags).to_string()).map_err(|e| e.to_string())
}

/// Reads all boolean flags from {app_data_dir}/native_flags.json.
/// Returns an empty object if the file does not exist yet.
#[tauri::command]
pub(crate) fn get_native_flags(app: tauri::AppHandle) -> serde_json::Value {
    let data_dir = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(e) => {
            log::warn!("[Flags] app_data_dir() failed: {e}");
            return serde_json::Value::Object(serde_json::Map::new());
        }
    };
    let path = data_dir.join("native_flags.json");
    if !path.exists() {
        return serde_json::Value::Object(serde_json::Map::new());
    }
    let Ok(bytes) = std::fs::read(&path) else {
        return serde_json::Value::Object(serde_json::Map::new());
    };
    serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Object(serde_json::Map::new()))
}
