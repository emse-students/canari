// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use base64::Engine as _;
use mls_core::{DecryptErrorKind, MlsManager};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use tauri::Manager;

#[cfg(any(target_os = "android", target_os = "ios"))]
mod mobile;

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
use tauri::{
    image::Image,
    menu::{MenuBuilder, MenuItemBuilder},
    tray::TrayIconBuilder,
    WindowEvent,
};

// State wrapper
struct AppState {
    mls_manager: Arc<Mutex<Option<MlsManager>>>,
}

// ─── Concurrence multi-moteur mls.bin (Passe 2 : C1 / C2 / FCM3) ──────────────
//
// Sur Android, trois moteurs MLS coexistent dans le MEME process (meme .so Rust) :
// foreground (MlsManager natif en memoire via les commandes Tauri), FCM JNI et Worker JNI.
// Seuls FCM<->Worker partageaient un verrou (Kotlin `MlsStateLock`) ; le foreground n'y
// participait pas et ne rechargeait jamais `mls.bin`. Resultat : une avancee background
// (Welcome/send/worker) etait ecrasee au retour premier plan (lost-update -> SecretReuse).

/// Verrou process-global serialisant les ECRITURES de `mls.bin` entre les trois moteurs. Tenu
/// brievement, juste autour de l'ecriture atomique. `nativeDecryptMessage` n'ecrit pas (manager
/// ephemere) -> non concerne. (C1)
fn mls_bin_write_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// Echeance (ms depuis epoch) jusqu'a laquelle le foreground est repute actif. Tant que
/// `now < echeance`, les ecritures background JNI ABANDONNENT pour ne pas ecraser l'etat que le
/// foreground detient en memoire et n'a pas encore recharge. Rafraichie par heartbeat tant que la
/// WebView est visible ; expire seule si le foreground meurt/gele -> AUCUN stuck-true qui tuerait
/// la livraison background (regression FCM1/FCM2). (C1 / FCM3)
fn foreground_active_until() -> &'static AtomicI64 {
    static UNTIL: AtomicI64 = AtomicI64::new(0);
    &UNTIL
}

/// Marge du heartbeat foreground : doit depasser confortablement sa cadence (10 s) pour ne pas
/// expirer a tort pendant une app reellement au premier plan.
const FOREGROUND_GRACE_MS: i64 = 30_000;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

/// Rafraichit la garde foreground (heartbeat, resume, ou ecriture foreground).
pub(crate) fn mark_foreground_active() {
    foreground_active_until().store(now_ms() + FOREGROUND_GRACE_MS, Ordering::SeqCst);
}

/// Vrai tant que la garde foreground n'a pas expire (le background doit alors s'abstenir d'ecrire).
/// Mobile uniquement : les ecrivains background (`background_write_mls_bin`) y vivent.
#[cfg(any(target_os = "android", target_os = "ios"))]
fn foreground_is_active() -> bool {
    now_ms() < foreground_active_until().load(Ordering::SeqCst)
}

/// Pool SQLite dédié aux messages MLS en attente (gap du Sender Ratchet).
/// Séparé de tauri-plugin-sql (côté JS) pour rester accessible depuis les commandes Rust.
struct PendingDb(Arc<sqlx::SqlitePool>);

/// Client HTTP réutilisable (pool de connexions) pour le gap fetching côté Rust.
struct HttpClient(reqwest::Client);

#[derive(serde::Serialize)]
struct KeyPackageBatchResult {
    fallback: Vec<u8>,
    pool_packages: Vec<Vec<u8>>,
    state: Vec<u8>,
}

/// Per-message outcome for batch MLS decrypt (history catch-up).
#[derive(serde::Serialize, Clone)]
struct BatchDecryptItem {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<Vec<u8>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn map_decrypt_outcome(result: Result<Option<Vec<u8>>, mls_core::MlsError>) -> BatchDecryptItem {
    match result {
        Ok(Some(data)) => BatchDecryptItem {
            ok: true,
            data: Some(data),
            error: None,
        },
        Ok(None) => BatchDecryptItem {
            ok: true,
            data: None,
            error: None,
        },
        Err(e) => {
            // SecretReuse = doublon benin (cle deja consommee) : ACK + drop, parite temps-reel. [[S5]]
            if e.decrypt_kind() == DecryptErrorKind::SecretReuse {
                return BatchDecryptItem {
                    ok: true,
                    data: None,
                    error: None,
                };
            }
            BatchDecryptItem {
                ok: false,
                data: None,
                error: Some(e.to_string()),
            }
        }
    }
}

/// Decrypts an ordered page of ciphertexts under one manager lock (S5 native path).
fn decrypt_messages_batch(
    manager: &mut MlsManager,
    group_id: &str,
    messages: &[Vec<u8>],
) -> Vec<BatchDecryptItem> {
    let refs: Vec<&[u8]> = messages.iter().map(|m| m.as_slice()).collect();
    manager
        .process_incoming_messages(group_id, &refs)
        .into_iter()
        .map(map_decrypt_outcome)
        .collect()
}

/// Ecrit `mls.bin` cote background sous le verrou global, SAUF si le foreground est actif (auquel
/// cas on abandonne : le foreground detient l'etat a jour en memoire et l'ecraserait - C1/FCM3).
/// L'erreur "foreground actif" laisse le travail en attente, repris au prochain passage foreground.
#[cfg(any(target_os = "android", target_os = "ios"))]
pub(crate) fn background_write_mls_bin(path: &std::path::Path, data: &[u8]) -> Result<(), String> {
    let _guard = mls_bin_write_lock()
        .lock()
        .map_err(|_| "mls_bin write lock poisoned".to_string())?;
    if foreground_is_active() {
        return Err(
            "foreground actif - ecriture mls.bin background abandonnee (C1/FCM3)".to_string(),
        );
    }
    write_mls_bin_atomically(path, data)
}

/// Écrit `data` dans `path` de façon atomique : écriture dans un fichier temporaire
/// suivi d'un `rename(2)`, qui est atomique sur Linux/Android au sein du même filesystem.
/// Garantit que le lecteur ne voit jamais un fichier partiellement écrit.
fn write_mls_bin_atomically(path: &std::path::Path, data: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("bin.tmp");
    std::fs::write(&tmp, data).map_err(|e| format!("write mls.bin.tmp: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("rename mls.bin.tmp → mls.bin: {e}"))
}

fn write_mls_state_blob(app: &tauri::AppHandle, data: &[u8]) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    // Une ecriture foreground prouve que le foreground est vivant : rafraichir la garde pour que
    // les moteurs background s'abstiennent d'ecrire en parallele (C1/FCM3). Verrou global tenu
    // brievement autour de l'ecriture atomique.
    mark_foreground_active();
    let _guard = mls_bin_write_lock()
        .lock()
        .map_err(|_| "mls_bin write lock poisoned".to_string())?;
    write_mls_bin_atomically(&data_dir.join("mls.bin"), data)
}

// --- COMMANDS ---

#[tauri::command]
async fn initialiser_mls(
    user_id: String,
    device_id: String,
    pin: String,
    encrypted_state: Option<Vec<u8>>,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let manager_state = state.mls_manager.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let manager = MlsManager::load_encrypted(&user_id, &device_id, encrypted_state, &pin)
            .map_err(|e| e.to_string())?;

        let mut lock = manager_state
            .lock()
            .map_err(|_| "Failed to lock state".to_string())?;
        *lock = Some(manager);
        Ok::<String, String>("MLS Initialized".into())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn sauvegarder_mls(
    pin: String,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<u8>, String> {
    let manager_state = state.mls_manager.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let lock = manager_state
            .lock()
            .map_err(|_| "Failed to lock state".to_string())?;
        let manager = lock
            .as_ref()
            .ok_or_else(|| "MLS Manager not initialized".to_string())?;
        let encrypted = manager.save_encrypted(&pin).map_err(|e| e.to_string())?;
        Ok::<Vec<u8>, String>(encrypted)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn sauvegarder_mls_et_persister(
    pin: String,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<Vec<u8>, String> {
    let manager_state = state.mls_manager.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let lock = manager_state
            .lock()
            .map_err(|_| "Failed to lock state".to_string())?;
        let manager = lock
            .as_ref()
            .ok_or_else(|| "MLS Manager not initialized".to_string())?;
        let encrypted = manager.save_encrypted(&pin).map_err(|e| e.to_string())?;
        write_mls_state_blob(&app, &encrypted)?;
        Ok::<Vec<u8>, String>(encrypted)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn creer_groupe(group_id: String, state: tauri::State<AppState>) -> Result<(), String> {
    let mut lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_mut().ok_or("MLS Manager not initialized")?;

    manager.create_group(group_id).map_err(|e| e.to_string())
}

#[tauri::command]
async fn generer_key_package(state: tauri::State<'_, AppState>) -> Result<Vec<u8>, String> {
    let manager_state = state.mls_manager.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let lock = manager_state
            .lock()
            .map_err(|_| "Failed to lock state".to_string())?;
        let manager = lock
            .as_ref()
            .ok_or_else(|| "MLS Manager not initialized".to_string())?;
        let fallback = manager.generate_key_package().map_err(|e| e.to_string())?;
        Ok::<Vec<u8>, String>(fallback)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn generer_key_packages(
    count: usize,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<Vec<u8>>, String> {
    let manager_state = state.mls_manager.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let lock = manager_state
            .lock()
            .map_err(|_| "Failed to lock state".to_string())?;
        let manager = lock
            .as_ref()
            .ok_or_else(|| "MLS Manager not initialized".to_string())?;
        let generated = manager
            .generate_key_packages(count)
            .map_err(|e| e.to_string())?;
        Ok::<Vec<Vec<u8>>, String>(generated)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn key_package_a_clef_privee(
    key_package_bytes: Vec<u8>,
    state: tauri::State<'_, AppState>,
) -> Result<bool, String> {
    let manager_state = state.mls_manager.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let lock = manager_state
            .lock()
            .map_err(|_| "Failed to lock state".to_string())?;
        let manager = lock
            .as_ref()
            .ok_or_else(|| "MLS Manager not initialized".to_string())?;
        let has_private = manager
            .key_package_has_private(&key_package_bytes)
            .map_err(|e| e.to_string())?;
        Ok::<bool, String>(has_private)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn generer_key_packages_et_persister(
    pin: String,
    count: usize,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<KeyPackageBatchResult, String> {
    let manager_state = state.mls_manager.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let lock = manager_state
            .lock()
            .map_err(|_| "Failed to lock state".to_string())?;
        let manager = lock
            .as_ref()
            .ok_or_else(|| "MLS Manager not initialized".to_string())?;

        log::debug!(
            "generer_key_packages_et_persister start count={} (batch native path)",
            count
        );
        let fallback = manager.generate_key_package().map_err(|e| e.to_string())?;
        let pool_packages = if count > 0 {
            manager
                .generate_key_packages(count)
                .map_err(|e| e.to_string())?
        } else {
            Vec::new()
        };
        let encrypted_state = manager.save_encrypted(&pin).map_err(|e| e.to_string())?;
        write_mls_state_blob(&app, &encrypted_state)?;
        log::debug!(
            "generer_key_packages_et_persister done count={} state_bytes={}",
            count,
            encrypted_state.len()
        );

        Ok::<KeyPackageBatchResult, String>(KeyPackageBatchResult {
            fallback,
            pool_packages,
            state: encrypted_state,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn oublier_groupe(
    group_id: String,
    // u64 : meme largeur que l'epoch source (Tauri serialise en JSON number cote JS). [[S4]]
    min_epoch: u64,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let mut lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_mut().ok_or("MLS Manager not initialized")?;
    manager.forget_group(&group_id, min_epoch);
    Ok(())
}

/// Purge définitive d'un groupe (Poison Pill) : mémoire + stockage OpenMLS + verrou
/// d'epoch à MAX. Aucun Welcome ne sera jamais accepté pour ce groupId après cet appel.
#[tauri::command]
fn supprimer_groupe(group_id: String, state: tauri::State<AppState>) -> Result<(), String> {
    let mut lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_mut().ok_or("MLS Manager not initialized")?;
    manager.drop_group(&group_id);
    Ok(())
}

#[tauri::command]
fn lister_groupes(state: tauri::State<AppState>) -> Result<Vec<String>, String> {
    let lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_ref().ok_or("MLS Manager not initialized")?;
    Ok(manager.get_known_groups())
}

#[tauri::command]
fn obtenir_epoch(group_id: String, state: tauri::State<AppState>) -> Result<u64, String> {
    let lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_ref().ok_or("MLS Manager not initialized")?;
    // u64 : pas de troncature ; Tauri serialise en JSON number (exact <= 2^53, jamais atteint). [[S4]]
    manager.get_epoch(&group_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn ajouter_membres_bulk(
    group_id: String,
    key_packages_bytes: Vec<Vec<u8>>,
    state: tauri::State<AppState>,
) -> Result<(Vec<u8>, Option<Vec<u8>>, Vec<u32>, Vec<u32>), String> {
    let mut lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_mut().ok_or("MLS Manager not initialized")?;

    // Stage-only (C7-A): the commit is NOT merged here. The caller validates it server-side then
    // calls confirmer_commit (accepted) / annuler_commit (rejected), and reads the post-merge
    // ratchet tree via exporter_ratchet_tree.
    let refs: Vec<&[u8]> = key_packages_bytes.iter().map(|v| v.as_slice()).collect();
    manager
        .add_members_bulk(&group_id, &refs)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn trailer_welcome(
    welcome_bytes: Vec<u8>,
    ratchet_tree_bytes: Option<Vec<u8>>,
    state: tauri::State<AppState>,
) -> Result<String, String> {
    let mut lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_mut().ok_or("MLS Manager not initialized")?;

    manager
        .process_welcome(&welcome_bytes, ratchet_tree_bytes.as_deref())
        .map_err(|e| {
            log::error!(
                "[WELCOME] Erreur critique lors du traitement du Welcome MLS: {:?}",
                e
            );
            e.to_string()
        })
}

#[tauri::command]
fn envoyer_message(
    group_id: String,
    message: String, // Assume string for simplicity
    state: tauri::State<AppState>,
) -> Result<Vec<u8>, String> {
    let mut lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_mut().ok_or("MLS Manager not initialized")?;

    manager
        .send_message(&group_id, message.as_bytes())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn envoyer_message_bytes(
    group_id: String,
    message_bytes: Vec<u8>,
    state: tauri::State<AppState>,
) -> Result<Vec<u8>, String> {
    let mut lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_mut().ok_or("MLS Manager not initialized")?;

    manager
        .send_message(&group_id, &message_bytes)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn recevoir_message(
    group_id: String,
    message_bytes: Vec<u8>,
    state: tauri::State<AppState>,
) -> Result<Option<String>, String> {
    let mut lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_mut().ok_or("MLS Manager not initialized")?;

    let res = manager
        .process_incoming_message(&group_id, &message_bytes)
        .map_err(|e| {
            log::error!("recevoir_message failed: group={} err={}", group_id, e);
            e.to_string()
        })?;

    match res {
        Some(bytes) => Ok(Some(String::from_utf8_lossy(&bytes).to_string())),
        None => Ok(None),
    }
}

#[tauri::command]
fn retirer_membres(
    group_id: String,
    user_ids: Vec<String>,
    state: tauri::State<AppState>,
) -> Result<Vec<u8>, String> {
    let mut lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_mut().ok_or("MLS Manager not initialized")?;

    let id_slices: Vec<&str> = user_ids.iter().map(|s| s.as_str()).collect();
    manager
        .remove_members_for_users(&group_id, &id_slices)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn retirer_membres_par_appareil(
    group_id: String,
    device_identities: Vec<String>,
    state: tauri::State<AppState>,
) -> Result<Vec<u8>, String> {
    let mut lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_mut().ok_or("MLS Manager not initialized")?;

    let id_slices: Vec<&str> = device_identities.iter().map(|s| s.as_str()).collect();
    manager
        .remove_members_for_devices(&group_id, &id_slices)
        .map_err(|e| e.to_string())
}

/// Confirme (merge) un commit *stage* (ADD ou REMOVE) APRES acceptation serveur (`validateCommit`).
/// Avance l'epoch local. Pendant de `annuler_commit`. [[C7]] Option A : valider-puis-merger,
/// jamais de fork local sur rejet (regime unifie ADD+REMOVE).
///
/// NE persiste PAS : l'appelant enchaine `persistMlsStateAfterMutation` (qui detient le pin,
/// recupere via le keystore au niveau session) comme pour tout autre mutation - meme fenetre
/// merge->persist qu'avant.
#[tauri::command]
fn confirmer_commit(group_id: String, state: tauri::State<AppState>) -> Result<(), String> {
    let mut lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_mut().ok_or("MLS Manager not initialized")?;
    manager
        .merge_pending_commit_for(&group_id)
        .map_err(|e| e.to_string())
}

/// Annule (clear) un commit *stage* (ADD ou REMOVE) quand le serveur le REJETTE. L'epoch local
/// reste inchange (aucun fork). Pas de persistance : `mls.bin` est deja a l'etat pre-stage. [[C7]]
#[tauri::command]
fn annuler_commit(group_id: String, state: tauri::State<AppState>) -> Result<(), String> {
    let mut lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_mut().ok_or("MLS Manager not initialized")?;
    manager
        .clear_pending_commit_for(&group_id)
        .map_err(|e| e.to_string())
}

/// Exporte le ratchet tree du groupe depuis l'etat COURANT (post-merge) pour le Welcome. Pour un
/// ADD, a appeler APRES `confirmer_commit` (le nouveau membre rejoint l'epoch N+1). [[C7]]
#[tauri::command]
fn exporter_ratchet_tree(
    group_id: String,
    state: tauri::State<AppState>,
) -> Result<Vec<u8>, String> {
    let lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_ref().ok_or("MLS Manager not initialized")?;
    manager
        .export_ratchet_tree_for(&group_id)
        .map_err(|e| e.to_string())
}

/// Exporte un GroupInfo auto-suffisant (arbre inclus) pour `group_id`, a stocker cote serveur et a
/// servir aux membres autorises qui rejoignent via un commit externe (`rejoindre_par_commit_externe`).
#[tauri::command]
fn exporter_group_info(group_id: String, state: tauri::State<AppState>) -> Result<Vec<u8>, String> {
    let lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_ref().ok_or("MLS Manager not initialized")?;
    manager
        .export_group_info(&group_id)
        .map_err(|e| e.to_string())
}

/// Rejoint un groupe via un commit externe construit depuis un GroupInfo servi. Le groupe retourne
/// est a l'epoch N+1 avec le commit *stage* : l'appelant soumet le commit pour validation d'epoch
/// serveur (contre l'epoch de base du GroupInfo), puis `confirmer_commit` si accepte, ou
/// `oublier_groupe` + retry avec un GroupInfo plus frais si rejete (un commit externe ne s'annule
/// pas). Retourne (group_id, commit).
#[tauri::command]
fn rejoindre_par_commit_externe(
    group_info_bytes: Vec<u8>,
    state: tauri::State<AppState>,
) -> Result<(String, Vec<u8>), String> {
    let mut lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_mut().ok_or("MLS Manager not initialized")?;
    manager
        .join_by_external_commit(&group_info_bytes)
        .map_err(|e| e.to_string())
}

/// Déchiffre un message MLS entrant.
/// Si le déchiffrement échoue avec "Process error:" (gap du Sender Ratchet : la
/// génération reçue est supérieure à celle attendue), le message est stocké dans
/// SQLite via PendingDb et la commande retourne Err("GAP_QUEUED:<group_id>") pour
/// que le frontend sache qu'il doit aller chercher les messages manquants.
#[tauri::command]
async fn recevoir_message_bytes(
    group_id: String,
    message_bytes: Vec<u8>,
    state: tauri::State<'_, AppState>,
    pending_db: tauri::State<'_, PendingDb>,
) -> Result<Option<Vec<u8>>, String> {
    // Chantier 1 : détection proactive de l'epoch gap AVANT tout déchiffrement.
    // L'epoch est en clair dans l'en-tête MLS → aucune clé de ratchet consommée.
    // Le MutexGuard est libéré dans le bloc intérieur AVANT tout .await.
    let epoch_gap: Option<(u64, u64)> = {
        let lock = state
            .mls_manager
            .lock()
            .map_err(|_| "Failed to lock state")?;
        match lock.as_ref() {
            Some(manager) => {
                let group_epoch = match manager.get_epoch(&group_id) {
                    Ok(epoch) => Some(epoch),
                    Err(_) => None,
                };
                match (MlsManager::parse_message_epoch(&message_bytes), group_epoch) {
                    (Some(msg_ep), Some(group_ep)) if msg_ep > group_ep => Some((msg_ep, group_ep)),
                    _ => None,
                }
            }
            None => None,
        }
        // lock est libéré ici - aucun await n'a encore eu lieu
    };
    if let Some((msg_ep, group_ep)) = epoch_gap {
        log::warn!(
            "[GAP] Epoch gap détecté AVANT déchiffrement : \
             msg_epoch={} > group_epoch={} pour group={}. \
             Mise en attente et déclenchement de la resync.",
            msg_ep,
            group_ep,
            group_id
        );
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos() as i64;
        let id = format!("{}-epoch-{}", group_id, ts);
        let insert_result = sqlx::query(
            "INSERT OR IGNORE INTO pending_mls_messages \
             (id, group_id, ciphertext, created_at, is_ready) VALUES (?, ?, ?, ?, 0)",
        )
        .bind(&id)
        .bind(&group_id)
        .bind(message_bytes.as_slice())
        .bind(ts)
        .execute(&*pending_db.0)
        .await;
        match insert_result {
            Ok(_) => (),
            Err(db_e) => {
                log::error!("[GAP] DB insert (epoch pre-check) failed: {}", db_e);
                return Err(format!("GAP_DB_INSERT_FAILED:{}:{}", group_id, db_e));
            }
        }
        return Err(format!(
            "GAP_QUEUED:{}:msg_epoch={}:group_epoch={}",
            group_id, msg_ep, group_ep
        ));
    }

    // Acquiert + libère le Mutex AVANT toute opération async pour éviter les
    // deadlocks avec std::sync::Mutex (non-Send across await points).
    let result = {
        let mut lock = state
            .mls_manager
            .lock()
            .map_err(|_| "Failed to lock state")?;
        let manager = lock.as_mut().ok_or("MLS Manager not initialized")?;
        manager.process_incoming_message(&group_id, &message_bytes)
    };

    match result {
        Ok(val) => Ok(val),
        Err(e) => {
            let err_str = e.to_string();
            log::error!(
                "recevoir_message_bytes failed: group={} err={}",
                group_id,
                err_str
            );

            // Classification centralisee cote mls-core (source unique du string-matching). [[S5]]
            match e.decrypt_kind() {
                // Corruption détectée par mls-core → état irrécupérable, déclencher re-bootstrap.
                DecryptErrorKind::Unrecoverable => Err(format!("UNRECOVERABLE:{}", group_id)),

                // SecretReuseError = la clé de ratchet de ce message a déjà été consommée
                // (doublon : livraison realtime + queue, ou requeue après restart). À l'inverse
                // d'un gap de génération FUTURE, elle ne déchiffrera JAMAIS : la mettre en file
                // SQLite la ferait boucler indéfiniment. On la traite comme un doublon bénin -
                // Ok(None) → le frontend ACK et la supprime (parité avec le chemin WASM web).
                DecryptErrorKind::SecretReuse => {
                    log::debug!(
                        "[DUP] SecretReuseError group={} - doublon déjà consommé, ACK silencieux",
                        group_id
                    );
                    Ok(None)
                }

                // "Process error:" = erreur OpenMLS sur le même epoch → probable gap du Sender
                // Ratchet (génération future reçue) → mise en file SQLite pour retry.
                DecryptErrorKind::SenderRatchetGap => {
                    log::warn!(
                        "[GAP] Sender Ratchet gap pour group={} - message mis en file SQLite",
                        group_id
                    );
                    let ts = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_nanos() as i64;
                    let id = format!("{}-gen-{}", group_id, ts);
                    let insert_result = sqlx::query(
                        "INSERT OR IGNORE INTO pending_mls_messages \
                         (id, group_id, ciphertext, created_at, is_ready) VALUES (?, ?, ?, ?, 0)",
                    )
                    .bind(&id)
                    .bind(&group_id)
                    .bind(message_bytes.as_slice())
                    .bind(ts)
                    .execute(&*pending_db.0)
                    .await;
                    if let Err(db_e) = insert_result {
                        log::error!("[GAP] DB store failed: {}", db_e);
                        return Err(format!("GAP_DB_INSERT_FAILED:{}:{}", group_id, db_e));
                    }
                    // Embed the original OpenMLS error so the frontend can log it.
                    Err(format!("GAP_QUEUED:{}:{}", group_id, err_str))
                }

                DecryptErrorKind::Other => Err(err_str),
            }
        }
    }
}

/// Decrypts a page of MLS ciphertexts in one IPC crossing (ratchet order preserved).
#[tauri::command]
async fn recevoir_messages_batch(
    group_id: String,
    messages: Vec<Vec<u8>>,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<BatchDecryptItem>, String> {
    let manager_state = state.mls_manager.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut lock = manager_state
            .lock()
            .map_err(|_| "Failed to lock state".to_string())?;
        let manager = lock
            .as_mut()
            .ok_or_else(|| "MLS Manager not initialized".to_string())?;
        log::debug!(
            "recevoir_messages_batch group={} count={}",
            group_id,
            messages.len()
        );
        Ok::<Vec<BatchDecryptItem>, String>(decrypt_messages_batch(manager, &group_id, &messages))
    })
    .await
    .map_err(|e| e.to_string())?
}

// ─── Re-Bootstrap (Fail-Safe) ─────────────────────────────────────────────────

/// Résultat du bootstrap retourné au frontend TypeScript.
#[derive(serde::Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum BootstrapOutcome {
    /// Bootstrap réussi : le frontend doit envoyer les Welcome + le commit.
    Success {
        commit: Vec<u8>,
        welcome: Option<Vec<u8>>,
        added_device_ids: Vec<String>,
        ratchet_tree: Option<Vec<u8>>,
        new_bootstrap_version: u32,
    },
    /// Race condition : un autre device a déjà bootstrappé le groupe.
    /// Le frontend doit ignorer et attendre le Welcome entrant.
    Conflict,
    /// Aucun device tiers à inviter (groupe solo ou tous hors-ligne).
    NoMembers,
}

#[derive(serde::Deserialize)]
struct DeviceEntry {
    #[serde(rename = "keyPackage")]
    key_package: String, // base64
    #[serde(rename = "deviceId")]
    device_id: String,
}

#[derive(serde::Deserialize)]
struct ClaimBootstrapResponse {
    #[serde(rename = "bootstrapVersion")]
    bootstrap_version: u32,
}

/// Fail-Safe universel : recrée un groupe MLS mort de zéro.
///
/// Séquence atomique du point de vue du réseau :
///   1. Acquiert le verrou optimiste côté serveur (`claim-bootstrap`).
///      Si 409 → un autre device a gagné la course → retourne Conflict.
///   2. Remet l'epoch serveur à 0 (`reset-epoch`).
///   3. Crée un état MLS frais en local (`force_create_group`).
///   4. Récupère les KeyPackages de tous les membres via l'API.
///   5. Ajoute tous les devices en bulk (`add_members_bulk`).
///   6. Sauvegarde l'état MLS chiffré (mls.bin + checkpoint SQLite).
///   7. Remet à zéro le compteur de défaillances consécutives.
///
/// La complétion (envoi du Welcome + commit) est laissée au frontend TypeScript
/// car elle implique de multiples appels réseau et de la logique applicative.
#[tauri::command]
async fn bootstrap_dead_conversation(
    conversation_id: String,
    member_user_ids: Vec<String>,
    expected_bootstrap_version: u32,
    auth_token: String,
    base_url: String,
    pin: String,
    state: tauri::State<'_, AppState>,
    pending_db: tauri::State<'_, PendingDb>,
    http_client: tauri::State<'_, HttpClient>,
    app: tauri::AppHandle,
) -> Result<BootstrapOutcome, String> {
    // ── Étape 1 : Acquérir le verrou optimiste ────────────────────────────────
    let base = base_url.trim_end_matches('/');
    let claim_url = format!(
        "{}/api/mls/groups/{}/claim-bootstrap",
        base, conversation_id
    );
    let claim_resp = http_client
        .0
        .post(&claim_url)
        .header("Authorization", format!("Bearer {}", auth_token))
        .header("Content-Type", "application/json")
        .body(format!(
            r#"{{"expectedVersion":{}}}"#,
            expected_bootstrap_version
        ))
        .send()
        .await
        .map_err(|e| format!("claim-bootstrap HTTP error: {}", e))?;

    if claim_resp.status() == 409 {
        log::warn!(
            "[BOOTSTRAP] Race condition détectée pour group={} - un autre device a déjà bootstrappé.",
            conversation_id
        );
        return Ok(BootstrapOutcome::Conflict);
    }
    if !claim_resp.status().is_success() {
        return Err(format!("claim-bootstrap failed: {}", claim_resp.status()));
    }
    let claim_body: ClaimBootstrapResponse = claim_resp
        .json()
        .await
        .map_err(|e| format!("claim-bootstrap response parse error: {}", e))?;
    let new_bootstrap_version = claim_body.bootstrap_version;

    // ── Étape 2 : Reset de l'epoch serveur à 0 ───────────────────────────────
    let reset_url = format!("{}/api/mls/groups/{}/reset-epoch", base, conversation_id);
    let reset_resp = http_client
        .0
        .post(&reset_url)
        .header("Authorization", format!("Bearer {}", auth_token))
        .send()
        .await
        .map_err(|e| format!("reset-epoch HTTP error: {}", e))?;
    if !reset_resp.status().is_success() {
        log::warn!(
            "[BOOTSTRAP] reset-epoch failed ({}) - on continue quand même.",
            reset_resp.status()
        );
    }

    // ── Étape 3 : Créer un état MLS frais en local ───────────────────────────
    {
        let mut lock = state
            .mls_manager
            .lock()
            .map_err(|_| "Failed to lock state")?;
        let manager = lock.as_mut().ok_or("MLS Manager not initialized")?;
        manager
            .force_create_group(conversation_id.clone())
            .map_err(|e| e.to_string())?;
    }

    // ── Étape 4 : Récupérer les KeyPackages de chaque membre ─────────────────
    // Tous les appels HTTP se font HORS du Mutex (pas d'await sous lock).
    let mut all_key_packages: Vec<Vec<u8>> = Vec::new();
    let mut added_device_ids: Vec<String> = Vec::new();

    for user_id in &member_user_ids {
        let devices_url = format!("{}/api/mls/devices/{}", base, user_id);
        let resp = match http_client
            .0
            .get(&devices_url)
            .header("Authorization", format!("Bearer {}", auth_token))
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => r,
            Ok(r) => {
                log::warn!("[BOOTSTRAP] fetchUserDevices({}) → {}", user_id, r.status());
                continue;
            }
            Err(e) => {
                log::warn!(
                    "[BOOTSTRAP] fetchUserDevices({}) network error: {}",
                    user_id,
                    e
                );
                continue;
            }
        };

        let devices: Vec<DeviceEntry> = match resp.json().await {
            Ok(d) => d,
            Err(e) => {
                log::warn!(
                    "[BOOTSTRAP] fetchUserDevices({}) parse error: {}",
                    user_id,
                    e
                );
                continue;
            }
        };

        for device in devices {
            match base64::engine::general_purpose::STANDARD.decode(&device.key_package) {
                Ok(kp_bytes) => {
                    all_key_packages.push(kp_bytes);
                    added_device_ids.push(device.device_id);
                }
                Err(e) => {
                    log::warn!(
                        "[BOOTSTRAP] base64 decode failed for device {}: {}",
                        device.device_id,
                        e
                    );
                }
            }
        }
    }

    if all_key_packages.is_empty() {
        log::warn!(
            "[BOOTSTRAP] Aucun KeyPackage valide pour group={} - bootstrap annulé.",
            conversation_id
        );
        return Ok(BootstrapOutcome::NoMembers);
    }

    // ── Étape 5 : Ajouter tous les devices en bulk ───────────────────────────
    let (commit, welcome, ratchet_tree) = {
        let mut lock = state
            .mls_manager
            .lock()
            .map_err(|_| "Failed to lock state")?;
        let manager = lock.as_mut().ok_or("MLS Manager not initialized")?;
        let refs: Vec<&[u8]> = all_key_packages.iter().map(|v| v.as_slice()).collect();
        // Stage-only add (C7-A). The bootstrap holds the Redis bootstrap-lock and resets the epoch
        // to 0, so there is no concurrent commit to lose: merge immediately, then export the
        // post-merge ratchet tree the new members join with.
        let (commit_b, welcome_b, _added, skipped) = manager
            .add_members_bulk(&conversation_id, &refs)
            .map_err(|e| e.to_string())?;
        if !skipped.is_empty() {
            log::warn!(
                "[BOOTSTRAP] {} KeyPackage(s) invalide(s) ignore(s) pour group={} (indices {:?}) - device(s) non re-invite(s). [[C5]]",
                skipped.len(),
                conversation_id,
                skipped
            );
        }
        manager
            .merge_pending_commit_for(&conversation_id)
            .map_err(|e| e.to_string())?;
        let rt_b = manager
            .export_ratchet_tree_for(&conversation_id)
            .map_err(|e| e.to_string())?;
        (commit_b, welcome_b, Some(rt_b))
    };

    // ── Étape 6 : Sauvegarder l'état MLS ────────────────────────────────────
    let enc = {
        let lock = state
            .mls_manager
            .lock()
            .map_err(|_| "Failed to lock state")?;
        let manager = lock.as_ref().ok_or("MLS Manager not initialized")?;
        manager.save_encrypted(&pin).map_err(|e| e.to_string())?
    };
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    let mut tx = pending_db.0.begin().await.map_err(|e| e.to_string())?;
    sqlx::query(
        "INSERT OR REPLACE INTO mls_state_checkpoint (id, state, saved_at) VALUES (1, ?, ?)",
    )
    .bind(enc.as_slice())
    .bind(ts)
    .execute(&mut *tx)
    .await
    .map_err(|e| e.to_string())?;
    tx.commit().await.map_err(|e| e.to_string())?;

    write_mls_state_blob(&app, &enc)?;

    log::info!(
        "[BOOTSTRAP] Groupe {} re-bootstrappé avec succès ({} devices).",
        conversation_id,
        added_device_ids.len()
    );

    Ok(BootstrapOutcome::Success {
        commit,
        welcome,
        added_device_ids,
        ratchet_tree,
        new_bootstrap_version,
    })
}

#[tauri::command]
fn exporter_secret(
    group_id: String,
    label: String,
    context: Option<Vec<u8>>,
    key_len: usize,
    state: tauri::State<AppState>,
) -> Result<Vec<u8>, String> {
    let lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_ref().ok_or("MLS Manager not initialized")?;

    manager
        .export_secret(
            &group_id,
            &label,
            context.as_deref().unwrap_or(&[]),
            key_len,
        )
        .map_err(|e| e.to_string())
}

/// Retourne le token FCM stocké par CanariFirebaseMessagingService.
/// Vérifie que le Keystore Android peut lire le push secret (flag écrit par CanariApplication).
/// Retourne `{"ok":true}` ou `{"ok":false,"reason":"no_context"|"no_secret"}`.
/// Sur desktop/web, toujours OK (pas de Keystore Android).
#[tauri::command]
fn check_push_secret_health(app: tauri::AppHandle) -> serde_json::Value {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let data_dir = match app.path().app_data_dir() {
            Ok(d) => d,
            Err(_) => return serde_json::json!({"ok": false, "reason": "no_context"}),
        };
        // Si push_context.json absent → utilisateur non encore authentifié, situation normale.
        if !data_dir.join("push_context.json").exists() {
            return serde_json::json!({"ok": true});
        }
        // keystore_ok.flag écrit par CanariApplication.checkKeystoreHealth() au démarrage.
        if data_dir.join("keystore_ok.flag").exists() {
            return serde_json::json!({"ok": true});
        }
        // pending_push_secret.txt → migration en attente ; le service FCM peut déchiffrer
        // en fallback et le Keystore sera restauré au prochain démarrage de l'app.
        if data_dir.join("pending_push_secret.txt").exists() {
            log::info!("[PushHealth] pending_push_secret.txt présent → migration en attente, push fonctionnel");
            return serde_json::json!({"ok": true});
        }
        log::warn!(
            "[PushHealth] keystore_ok.flag et pending_push_secret.txt absents → Keystore perdu"
        );
        serde_json::json!({"ok": false, "reason": "no_secret"})
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = app;
        serde_json::json!({"ok": true})
    }
}

/// Lit {app_data_dir}/fcm_token.txt (ecrit par le code natif Android/iOS).
#[tauri::command]
fn get_fcm_token(app: tauri::AppHandle) -> Option<String> {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let data_dir = match app.path().app_data_dir() {
            Ok(d) => d,
            Err(e) => {
                log::warn!("[FCM] app_data_dir() failed: {e}");
                return None;
            }
        };
        match std::fs::read_to_string(data_dir.join("fcm_token.txt")) {
            Ok(token) => {
                let token = token.trim().to_string();
                if token.is_empty() {
                    log::warn!("[FCM] fcm_token.txt is empty");
                    None
                } else {
                    Some(token)
                }
            }
            Err(e) => {
                log::warn!("[FCM] read fcm_token.txt: {e}");
                None
            }
        }
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = app;
        None
    }
}

// ─── Fonction JNI appelée par CanariFirebaseMessagingService ─────────────────

/// Déchiffre un message MLS et retourne ses métadonnées complètes en JSON.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_fr_emse_canari_CanariFirebaseMessagingService_nativeDecryptMessage<
    'a,
>(
    mut env: jni::JNIEnv<'a>,
    _service: jni::objects::JObject<'a>,
    state_bytes: jni::objects::JByteArray<'a>,
    pin: jni::objects::JString<'a>,
    user_id: jni::objects::JString<'a>,
    device_id: jni::objects::JString<'a>,
    group_id: jni::objects::JString<'a>,
    ciphertext: jni::objects::JByteArray<'a>,
) -> jni::objects::JString<'a> {
    let result = (|| -> serde_json::Value {
        let state_vec = match env.convert_byte_array(&state_bytes) {
            Ok(v) => v,
            Err(_) => return serde_json::json!({ "ok": false }),
        };
        let pin_str: String = match env.get_string(&pin) {
            Ok(s) => s.into(),
            Err(_) => return serde_json::json!({ "ok": false }),
        };
        let user_id_str: String = match env.get_string(&user_id) {
            Ok(s) => s.into(),
            Err(_) => return serde_json::json!({ "ok": false }),
        };
        let device_id_str: String = match env.get_string(&device_id) {
            Ok(s) => s.into(),
            Err(_) => return serde_json::json!({ "ok": false }),
        };
        let group_id_str: String = match env.get_string(&group_id) {
            Ok(s) => s.into(),
            Err(_) => return serde_json::json!({ "ok": false }),
        };
        let cipher_vec = match env.convert_byte_array(&ciphertext) {
            Ok(v) => v,
            Err(_) => return serde_json::json!({ "ok": false }),
        };

        mobile::background::decrypt_push_message(
            &state_vec,
            &pin_str,
            &user_id_str,
            &device_id_str,
            &group_id_str,
            &cipher_vec,
        )
        .unwrap_or_else(|| serde_json::json!({ "ok": false }))
    })();

    let json_str = result.to_string();
    env.new_string(&json_str)
        .unwrap_or_else(|_| env.new_string("{\"ok\":false}").unwrap())
}

/// Returns the current MLS epoch of `group_id` in the persisted state, or -1 if unknown / the state
/// cannot be loaded. The background push path calls this to compute the `sinceEpoch` to fetch for
/// the in-memory commit catch-up (`nativeDecryptMessageWithCommits`). Read-only, never persists.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_fr_emse_canari_CanariFirebaseMessagingService_nativeGroupEpoch<'a>(
    mut env: jni::JNIEnv<'a>,
    _service: jni::objects::JObject<'a>,
    state_bytes: jni::objects::JByteArray<'a>,
    pin: jni::objects::JString<'a>,
    user_id: jni::objects::JString<'a>,
    device_id: jni::objects::JString<'a>,
    group_id: jni::objects::JString<'a>,
) -> jni::sys::jlong {
    let epoch = (|| -> Option<u64> {
        let state_vec = env.convert_byte_array(&state_bytes).ok()?;
        let pin_str: String = env.get_string(&pin).ok()?.into();
        let user_id_str: String = env.get_string(&user_id).ok()?.into();
        let device_id_str: String = env.get_string(&device_id).ok()?.into();
        let group_id_str: String = env.get_string(&group_id).ok()?.into();
        mobile::background::background_group_epoch(
            &state_vec,
            &pin_str,
            &user_id_str,
            &device_id_str,
            &group_id_str,
        )
    })();
    // u64 epochs are tiny in practice (< 2^53); the i64 cast never truncates a real epoch.
    epoch.map(|e| e as jni::sys::jlong).unwrap_or(-1)
}

/// Read-only in-memory commit catch-up decrypt: applies the ordered `commits_json` (JSON array of
/// base64 commit bytes) to an ephemeral manager to reach the message epoch, then decrypts
/// `ciphertext`. Returns the same metadata JSON as `nativeDecryptMessage`, or `{"ok":false}`. Never
/// writes mls.bin - the durable state is caught up later by the foreground commit-log replay.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_fr_emse_canari_CanariFirebaseMessagingService_nativeDecryptMessageWithCommits<
    'a,
>(
    mut env: jni::JNIEnv<'a>,
    _service: jni::objects::JObject<'a>,
    state_bytes: jni::objects::JByteArray<'a>,
    pin: jni::objects::JString<'a>,
    user_id: jni::objects::JString<'a>,
    device_id: jni::objects::JString<'a>,
    group_id: jni::objects::JString<'a>,
    commits_json: jni::objects::JString<'a>,
    ciphertext: jni::objects::JByteArray<'a>,
) -> jni::objects::JString<'a> {
    let result = (|| -> serde_json::Value {
        let state_vec = match env.convert_byte_array(&state_bytes) {
            Ok(v) => v,
            Err(_) => return serde_json::json!({ "ok": false }),
        };
        let pin_str: String = match env.get_string(&pin) {
            Ok(s) => s.into(),
            Err(_) => return serde_json::json!({ "ok": false }),
        };
        let user_id_str: String = match env.get_string(&user_id) {
            Ok(s) => s.into(),
            Err(_) => return serde_json::json!({ "ok": false }),
        };
        let device_id_str: String = match env.get_string(&device_id) {
            Ok(s) => s.into(),
            Err(_) => return serde_json::json!({ "ok": false }),
        };
        let group_id_str: String = match env.get_string(&group_id) {
            Ok(s) => s.into(),
            Err(_) => return serde_json::json!({ "ok": false }),
        };
        let commits_json_str: String = match env.get_string(&commits_json) {
            Ok(s) => s.into(),
            Err(_) => return serde_json::json!({ "ok": false }),
        };
        let cipher_vec = match env.convert_byte_array(&ciphertext) {
            Ok(v) => v,
            Err(_) => return serde_json::json!({ "ok": false }),
        };

        let commits = mobile::background::decode_commits_b64_json(&commits_json_str);
        mobile::background::decrypt_push_message_with_commits(
            &state_vec,
            &pin_str,
            &user_id_str,
            &device_id_str,
            &group_id_str,
            &commits,
            &cipher_vec,
        )
        .unwrap_or_else(|| serde_json::json!({ "ok": false }))
    })();

    let json_str = result.to_string();
    env.new_string(&json_str)
        .unwrap_or_else(|_| env.new_string("{\"ok\":false}").unwrap())
}

/// Decrypts a channel-message push (AES-256-GCM) and returns its metadata JSON.
/// Inputs are base64: the raw 32-byte epoch key (looked up by Kotlin in `channel_keys.json`),
/// the 12-byte nonce, and the `ciphertext||tag`. Returns `{"ok":false}` on any failure.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_fr_emse_canari_CanariFirebaseMessagingService_nativeDecryptChannelMessage<
    'a,
>(
    mut env: jni::JNIEnv<'a>,
    _service: jni::objects::JObject<'a>,
    key_b64: jni::objects::JString<'a>,
    nonce_b64: jni::objects::JString<'a>,
    ciphertext_b64: jni::objects::JString<'a>,
) -> jni::objects::JString<'a> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    let result = (|| -> serde_json::Value {
        let decode = |s: jni::objects::JString<'a>, env: &mut jni::JNIEnv<'a>| -> Option<Vec<u8>> {
            let raw: String = env.get_string(&s).ok()?.into();
            STANDARD.decode(raw.trim()).ok()
        };
        let key = match decode(key_b64, &mut env) {
            Some(v) => v,
            None => return serde_json::json!({ "ok": false }),
        };
        let nonce = match decode(nonce_b64, &mut env) {
            Some(v) => v,
            None => return serde_json::json!({ "ok": false }),
        };
        let ciphertext = match decode(ciphertext_b64, &mut env) {
            Some(v) => v,
            None => return serde_json::json!({ "ok": false }),
        };
        mobile::background::decrypt_channel_message(&key, &nonce, &ciphertext)
            .unwrap_or_else(|| serde_json::json!({ "ok": false }))
    })();

    let json_str = result.to_string();
    env.new_string(&json_str)
        .unwrap_or_else(|_| env.new_string("{\"ok\":false}").unwrap())
}

/// Decrypts an end-to-end-encrypted media blob (AES-256-GCM) into raw plaintext bytes for a
/// notification thumbnail (WP-XP-3). `key_b64`/`iv_b64` are the base64 CEK (32B) + IV (12B) parsed
/// from the MLS-decrypted `MediaMsg`; `ciphertext` is the opaque `ciphertext||tag` blob Kotlin
/// downloaded from `/api/mls/push/media/:mediaId`. Returns the decrypted bytes, or an EMPTY array on
/// any failure (Kotlin treats empty as "no thumbnail" and shows the text-only notification).
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_fr_emse_canari_CanariFirebaseMessagingService_nativeDecryptMedia<'a>(
    mut env: jni::JNIEnv<'a>,
    _service: jni::objects::JObject<'a>,
    key_b64: jni::objects::JString<'a>,
    iv_b64: jni::objects::JString<'a>,
    ciphertext: jni::objects::JByteArray<'a>,
) -> jni::objects::JByteArray<'a> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    let plaintext: Option<Vec<u8>> = (|| {
        let key: String = env.get_string(&key_b64).ok()?.into();
        let iv: String = env.get_string(&iv_b64).ok()?.into();
        let key = STANDARD.decode(key.trim()).ok()?;
        let iv = STANDARD.decode(iv.trim()).ok()?;
        let cipher_vec = env.convert_byte_array(&ciphertext).ok()?;
        mobile::background::decrypt_media_blob(&key, &iv, &cipher_vec)
    })();

    let bytes = plaintext.unwrap_or_default();
    // Empty `bytes` already yields an empty (non-null) array on the Ok path, which Kotlin reads as
    // "no thumbnail". The Err arm (JNI allocation failure) is a last resort - return a null array.
    match env.byte_array_from_slice(&bytes) {
        Ok(arr) => arr,
        Err(_) => unsafe { jni::objects::JByteArray::from_raw(std::ptr::null_mut()) },
    }
}

// ─── Commande Tauri : cache FCM ───────────────────────────────────────────────

/// Lit {app_data_dir}/fcm_message_cache.ndjson, efface le fichier et retourne les entrées.
/// Appelé au boot juste après login pour pré-injecter les messages déjà déchiffrés
/// lors de la réception FCM - évite d'attendre la sync MLS complète (~10s).
#[tauri::command]
fn read_and_clear_fcm_cache(app: tauri::AppHandle) -> Vec<serde_json::Value> {
    let data_dir = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(e) => {
            log::warn!("[FCM_CACHE] app_data_dir() failed: {e}");
            return vec![];
        }
    };
    let path = data_dir.join("fcm_message_cache.ndjson");
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return vec![],
        Err(e) => {
            log::warn!("[FCM_CACHE] lecture: {e}");
            return vec![];
        }
    };
    // Effacer immédiatement pour éviter les doublons au prochain boot
    if let Err(e) = std::fs::remove_file(&path) {
        log::warn!("[FCM_CACHE] suppression: {e}");
    }
    let entries: Vec<serde_json::Value> = content
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();
    log::info!("[FCM_CACHE] {} entrée(s) lue(s)", entries.len());
    entries
}

// ─── Commandes Tauri : mirror outbox (envoi background app tuée) ──────────────

/// Réécrit {app_data_dir}/outbox_pending.ndjson depuis l'instantané courant de l'outbox.
/// Chaque entrée porte le proto AppMessage *en clair* (base64) que le service Android chiffrera
/// contre l'epoch vivant via `nativeSendMessageBackground`. Fichier app-privé en clair, cohérent
/// avec push_context.json / fcm_message_cache.ndjson. Réécriture complète (pas d'append).
#[tauri::command]
fn store_outbox_mirror(
    app: tauri::AppHandle,
    entries: Vec<serde_json::Value>,
) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    let path = data_dir.join("outbox_pending.ndjson");
    // File vide => supprimer le fichier pour que le natif voie "rien en attente" sans le parser.
    if entries.is_empty() {
        if let Err(e) = std::fs::remove_file(&path) {
            if e.kind() != std::io::ErrorKind::NotFound {
                log::warn!("[OUTBOX_MIRROR] suppression: {e}");
            }
        }
        return Ok(());
    }
    let body = entries
        .iter()
        .map(|e| e.to_string())
        .collect::<Vec<_>>()
        .join("\n");
    std::fs::write(&path, body + "\n").map_err(|e| e.to_string())?;
    log::debug!("[OUTBOX_MIRROR] {} entrée(s) écrite(s)", entries.len());
    Ok(())
}

/// Merges one channel epoch key into {app_data_dir}/channel_keys.json so the Android background
/// service can AES-256-GCM-decrypt channel-message pushes (app killed). The file is a JSON map
/// `channelId -> { keyVersion -> base64(rawKey) }`; the raw 32-byte epoch key never leaves the
/// device. App-private plaintext storage, consistent with push_context.json / mls.bin.
#[tauri::command]
fn store_channel_key(
    app: tauri::AppHandle,
    channel_id: String,
    key_version: u32,
    key_b64: String,
) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    let path = data_dir.join("channel_keys.json");

    let mut root: serde_json::Value = match std::fs::read_to_string(&path) {
        Ok(c) => serde_json::from_str(&c).unwrap_or_else(|_| serde_json::json!({})),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => serde_json::json!({}),
        Err(e) => return Err(format!("read channel_keys.json: {e}")),
    };

    let map = root
        .as_object_mut()
        .ok_or("channel_keys.json is not an object")?;
    let channel_entry = map
        .entry(channel_id)
        .or_insert_with(|| serde_json::json!({}));
    if let Some(versions) = channel_entry.as_object_mut() {
        versions.insert(key_version.to_string(), serde_json::Value::String(key_b64));
    }

    std::fs::write(&path, root.to_string()).map_err(|e| e.to_string())?;
    log::debug!("[CHANNEL_KEYS] stored epoch key (version {key_version})");
    Ok(())
}

/// Lit {app_data_dir}/outbox_sent.ndjson (un messageId par ligne, écrit par le service Android
/// après un envoi background réussi), efface le fichier et retourne les ids. Appelé au login pour
/// supprimer de l'outbox les messages déjà livrés en arrière-plan.
#[tauri::command]
fn read_and_clear_outbox_sent(app: tauri::AppHandle) -> Vec<String> {
    let data_dir = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(e) => {
            log::warn!("[OUTBOX_MIRROR] app_data_dir() failed: {e}");
            return vec![];
        }
    };
    let path = data_dir.join("outbox_sent.ndjson");
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return vec![],
        Err(e) => {
            log::warn!("[OUTBOX_MIRROR] lecture sent: {e}");
            return vec![];
        }
    };
    if let Err(e) = std::fs::remove_file(&path) {
        log::warn!("[OUTBOX_MIRROR] suppression sent: {e}");
    }
    let ids: Vec<String> = content
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .map(|l| l.to_string())
        .collect();
    log::info!(
        "[OUTBOX_MIRROR] {} envoi(s) background à réconcilier",
        ids.len()
    );
    ids
}

// ─── Commandes Tauri : contexte push ─────────────────────────────────────────

/// Sauvegarde le PIN et le contexte de session dans {app_data_dir}/push_context.json
/// pour que CanariFirebaseMessagingService puisse déchiffrer les notifications push.
/// `push_token` est un Bearer token long-lived (ou vide sur desktop) utilisé par le
/// service Kotlin pour fetcher le proto MLS quand il n'est pas inclus inline dans FCM.
#[tauri::command]
fn store_push_context(
    pin: String,
    user_id: String,
    device_id: String,
    base_url: String,
    push_token: Option<String>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    let json = serde_json::json!({
        "pin": pin,
        "userId": user_id,
        "deviceId": device_id,
        "baseUrl": base_url,
        "pushToken": push_token.unwrap_or_default()
    });
    std::fs::write(data_dir.join("push_context.json"), json.to_string()).map_err(|e| e.to_string())
}

/// Write an already-encrypted MLS state blob into {app_data_dir}/mls.bin.
/// Accepts the encrypted bytes (as number[] from JS) and writes them verbatim.
/// This is used by the frontend when it already holds an encrypted state and
/// wants to persist it to the native app data directory (avoid WebView eviction).
#[tauri::command]
fn save_mls_state(app: tauri::AppHandle, data: Vec<u8>) -> Result<(), String> {
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
async fn recharger_mls_au_resume(
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
fn mls_foreground_heartbeat() {
    mark_foreground_active();
}

/// Libere la garde foreground (passage en arriere-plan) : autorise immediatement les moteurs JNI
/// a ecrire `mls.bin`. La garde expirerait de toute facon apres FOREGROUND_GRACE_MS ; ceci accelere
/// le cas propre (evenement `hidden` recu) pour ne pas retarder la livraison background.
#[tauri::command]
fn pause_mls_foreground() {
    foreground_active_until().store(0, Ordering::SeqCst);
}

#[tauri::command]
fn delete_mls_state(app: tauri::AppHandle) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let path = data_dir.join("mls.bin");
    if path.exists() {
        std::fs::remove_file(path).map_err(|e| e.to_string())
    } else {
        Ok(())
    }
}

/// Lit {app_data_dir}/push_context.json et retourne son contenu.
/// Utilisé pour restaurer le device ID quand localStorage est vide (réinstall Android).
#[tauri::command]
fn load_push_context(app: tauri::AppHandle) -> Option<serde_json::Value> {
    let data_dir = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(e) => {
            log::warn!("[PushCtx] app_data_dir() failed: {e}");
            return None;
        }
    };
    let path = data_dir.join("push_context.json");
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
        Err(e) => {
            log::warn!("[PushCtx] read push_context.json: {e}");
            return None;
        }
    };
    match serde_json::from_slice(&bytes) {
        Ok(v) => Some(v),
        Err(e) => {
            log::warn!("[PushCtx] parse push_context.json: {e}");
            None
        }
    }
}

/// Lit {app_data_dir}/mls.bin et retourne son contenu chiffré.
/// Retourne None si le fichier n'existe pas (première installation).
/// Utilisé au démarrage sur mobile quand localStorage est vide (WebView nettoyé).
#[tauri::command]
fn load_mls_state(app: tauri::AppHandle) -> Option<Vec<u8>> {
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
fn clear_app_data(app: tauri::AppHandle) -> Result<(), String> {
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

/// Écrit le pushSecret reçu du backend dans {app_data_dir}/pending_push_secret.txt.
/// CanariApplication.processPendingPushSecret() le lit au prochain démarrage,
/// le chiffre dans Android Keystore, puis supprime le fichier.
#[tauri::command]
fn store_push_secret(secret: String, app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
        std::fs::write(data_dir.join("pending_push_secret.txt"), &secret)
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = (secret, app);
    }
    Ok(())
}

/// Stores a boolean flag in {app_data_dir}/native_flags.json.
/// Used to persist UI flags (e.g. biometric enrollment) outside the WebView
/// storage layer, which MIUI and other aggressive OEMs may clear between sessions.
#[tauri::command]
fn set_native_flag(key: String, value: bool, app: tauri::AppHandle) -> Result<(), String> {
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
fn get_native_flags(app: tauri::AppHandle) -> serde_json::Value {
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // On Android: installe un hook de panic pour loguer le message AVANT le SIGABRT.
    // tauri-plugin-log gère seul l'initialisation du logger global (y compris logcat).
    #[cfg(target_os = "android")]
    {
        let prev = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            log::error!("PANIC: {info}");
            prev(info);
        }));
    }

    // In production desktop builds, `tauri://` scheme redirects are blocked by
    // WebKitGTK. We serve app assets via a local HTTP server instead, so the
    // OIDC redirect URI stays http://, which WebKitGTK accepts without complaint.
    #[cfg(all(desktop, not(dev)))]
    let port: u16 = 1421;

    let builder = tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Debug)
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_websocket::init())
        .plugin(tauri_plugin_store::Builder::default().build());

    #[cfg(all(desktop, not(dev)))]
    let builder = builder.plugin(tauri_plugin_localhost::Builder::new(port).build());

    #[cfg(mobile)]
    let builder = builder
        .plugin(tauri_plugin_biometric::init())
        .plugin(tauri_plugin_keystore::init())
        .plugin(tauri_plugin_deep_link::init());

    builder
        .manage(AppState {
            mls_manager: Arc::new(Mutex::new(None)),
        })
        .manage(HttpClient(
            reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(15))
                .build()
                .expect("Failed to build reqwest client"),
        ))
        .setup(move |app| {
            // ── Pool SQLite pour les messages MLS en attente (gap recovery) ────────
            // Initialisé ici avec le chemin appData définitif.
            // block_on est sûr : setup() s'exécute avant le démarrage de l'event loop Tauri.
            let data_dir = app.path().app_data_dir().map_err(|e| format!("{e}"))?;
            log::info!("[Path] app_data_dir = {}", data_dir.display());
            std::fs::create_dir_all(&data_dir)?;
            let db_path = data_dir.join("mls_pending.db");
            let pending_pool = tauri::async_runtime::block_on(async {
                sqlx::sqlite::SqlitePoolOptions::new()
                    .max_connections(4)
                    .connect_with(
                        sqlx::sqlite::SqliteConnectOptions::new()
                            .filename(&db_path)
                            .create_if_missing(true)
                            .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
                            // Attendre le verrou jusqu'a 5s au lieu d'echouer en SQLITE_BUSY :
                            // foreground (drain), FCM et WorkManager touchent tous mls_pending.db.
                            .busy_timeout(std::time::Duration::from_secs(5)),
                    )
                    .await
                    .map_err(|e| e.to_string())
            })
            .map_err(|e| format!("pending DB init: {e}"))?;

            // Chantier 1/3 : table pending avec colonne is_ready + migration pour installs existantes.
            tauri::async_runtime::block_on(async {
                sqlx::query(
                    "CREATE TABLE IF NOT EXISTS pending_mls_messages (\
                        id         TEXT    PRIMARY KEY,\
                        group_id   TEXT    NOT NULL,\
                        ciphertext BLOB    NOT NULL,\
                        created_at INTEGER NOT NULL,\
                        is_ready   INTEGER NOT NULL DEFAULT 0\
                    )",
                )
                .execute(&pending_pool)
                .await
                .map_err(|e| e.to_string())
            })
            .map_err(|e| format!("pending DB schema: {e}"))?;
            // Migration silencieuse : ajoute is_ready sur installs existantes (ignore si déjà présent).
            tauri::async_runtime::block_on(async {
                let _ = sqlx::query(
                    "ALTER TABLE pending_mls_messages \
                     ADD COLUMN is_ready INTEGER NOT NULL DEFAULT 0",
                )
                .execute(&pending_pool)
                .await; // duplicate column → erreur ignorée volontairement
                Ok::<(), String>(())
            })
            .map_err(|e: String| format!("pending DB migration: {e}"))?;
            // Migration silencieuse : ajoute attempt_count pour le circuit-breaker per-message.
            tauri::async_runtime::block_on(async {
                let _ = sqlx::query(
                    "ALTER TABLE pending_mls_messages \
                     ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0",
                )
                .execute(&pending_pool)
                .await; // duplicate column → erreur ignorée volontairement
                Ok::<(), String>(())
            })
            .map_err(|e: String| format!("pending DB migration attempt_count: {e}"))?;

            // Chantier 3 : table de checkpoint d'état MLS (singleton row id=1).
            // Permet une sauvegarde atomique (même transaction que is_ready=1).
            tauri::async_runtime::block_on(async {
                sqlx::query(
                    "CREATE TABLE IF NOT EXISTS mls_state_checkpoint (\
                        id       INTEGER PRIMARY KEY CHECK (id = 1),\
                        state    BLOB    NOT NULL,\
                        saved_at INTEGER NOT NULL\
                    )",
                )
                .execute(&pending_pool)
                .await
                .map_err(|e| e.to_string())
            })
            .map_err(|e| format!("pending DB checkpoint schema: {e}"))?;

            tauri::async_runtime::block_on(async {
                sqlx::query(
                    "CREATE INDEX IF NOT EXISTS idx_pmm_group \
                     ON pending_mls_messages(group_id, created_at)",
                )
                .execute(&pending_pool)
                .await
                .map_err(|e| e.to_string())
            })
            .map_err(|e| format!("pending DB index: {e}"))?;

            app.manage(PendingDb(Arc::new(pending_pool)));
            // ── Create main window on desktop ────────────────────────────────────
            // In dev mode: use the Vite dev server (already HTTP, no issues).
            // In production: use tauri-plugin-localhost so assets are served over
            // http://localhost:<port>. This means the OIDC redirect URI is HTTP,
            // and WebKitGTK won't block it with its "non-HTTP(S) scheme" error.
            #[cfg(desktop)]
            {
                #[cfg(dev)]
                let url = tauri::WebviewUrl::App(std::path::PathBuf::from("/"));

                #[cfg(not(dev))]
                let url = {
                    let localhost_url: tauri::Url =
                        format!("http://localhost:{}", port).parse().unwrap();
                    // Grant all app permissions to the localhost-served window.
                    app.add_capability(
                        tauri::ipc::CapabilityBuilder::new("localhost-cap")
                            .permission("core:default")
                            .permission("core:window:allow-show")
                            .permission("core:window:allow-hide")
                            .permission("core:window:allow-set-focus")
                            .permission("core:window:allow-unminimize")
                            .permission("core:window:allow-is-visible")
                            .permission("core:window:allow-close")
                            .permission("core:window:allow-destroy")
                            .permission("core:tray:default")
                            .permission("opener:default")
                            .permission("notification:default")
                            .permission("sql:default")
                            .permission("sql:allow-execute")
                            .remote(localhost_url.to_string())
                            .window("main"),
                    )?;
                    tauri::WebviewUrl::External(localhost_url)
                };

                // `from_config` reads `url` from the config struct itself, so the computed
                // `url` above (localhost in production, App("/") in dev) must be injected
                // into a cloned config - passing the config unmodified silently drops it and
                // the window loads the bundled asset:// origin instead of http://localhost,
                // breaking the OIDC-over-HTTP workaround this block exists for.
                let mut window_config = app.config().app.windows[0].clone();
                window_config.url = url;

                tauri::WebviewWindowBuilder::from_config(app.handle(), &window_config)?.build()?;
            }

            // ── Create main window on mobile ─────────────────────────────────────
            // On mobile tauri.conf.json uses "create": false (desktop-only builder
            // path above handles desktop). We build the window explicitly here so
            // the WebView actually loads instead of showing a blank screen.
            #[cfg(mobile)]
            tauri::WebviewWindowBuilder::new(
                app.handle(),
                "main",
                tauri::WebviewUrl::App(std::path::PathBuf::from("/")),
            )
            .build()?;

            // Open devtools automatically in debug mode
            #[cfg(debug_assertions)]
            {
                if let Some(win) = app.get_webview_window("main") {
                    win.open_devtools();
                }
            }

            // Paramètre utilisé uniquement sur desktop (system tray).
            #[cfg(mobile)]
            let _ = app;
            // ── System tray (desktop only) ──────────────────────────────
            #[cfg(desktop)]
            {
                let show_item = MenuItemBuilder::with_id("show", "Afficher Canari").build(app)?;
                let quit_item = MenuItemBuilder::with_id("quit", "Quitter").build(app)?;
                let menu = MenuBuilder::new(app)
                    .item(&show_item)
                    .separator()
                    .item(&quit_item)
                    .build()?;

                let icon = Image::from_path("icons/icon.png")
                    .or_else(|_| Image::from_path("icons/32x32.png"))
                    .unwrap_or_else(|_| {
                        app.default_window_icon().cloned().expect("no default icon")
                    });

                let _tray = TrayIconBuilder::new()
                    .icon(icon)
                    .menu(&menu)
                    .show_menu_on_left_click(false)
                    .tooltip("Canari")
                    .on_menu_event(|app_handle, event| match event.id().as_ref() {
                        "show" => {
                            if let Some(win) = app_handle.get_webview_window("main") {
                                let _ = win.show();
                                let _ = win.unminimize();
                                let _ = win.set_focus();
                            }
                        }
                        "quit" => {
                            app_handle.exit(0);
                        }
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let tauri::tray::TrayIconEvent::Click { button, .. } = event {
                            if button == tauri::tray::MouseButton::Left {
                                let app_handle = tray.app_handle();
                                if let Some(win) = app_handle.get_webview_window("main") {
                                    let _ = win.show();
                                    let _ = win.unminimize();
                                    let _ = win.set_focus();
                                }
                            }
                        }
                    })
                    .build(app)?;
            }

            Ok(())
        })
        // Intercept window close → hide to tray on desktop
        .on_window_event(|window, event| {
            #[cfg(mobile)]
            let _ = (window, event);
            #[cfg(desktop)]
            if let WindowEvent::CloseRequested { api, .. } = event {
                // Hide the window instead of closing it
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .invoke_handler(tauri::generate_handler![
            initialiser_mls,
            sauvegarder_mls,
            sauvegarder_mls_et_persister,
            creer_groupe,
            lister_groupes,
            oublier_groupe,
            supprimer_groupe,
            obtenir_epoch,
            generer_key_package,
            generer_key_packages,
            generer_key_packages_et_persister,
            key_package_a_clef_privee,
            ajouter_membres_bulk,
            retirer_membres,
            retirer_membres_par_appareil,
            confirmer_commit,
            annuler_commit,
            exporter_ratchet_tree,
            exporter_group_info,
            rejoindre_par_commit_externe,
            trailer_welcome,
            envoyer_message,
            envoyer_message_bytes,
            recevoir_message,
            recevoir_message_bytes,
            recevoir_messages_batch,
            exporter_secret,
            get_fcm_token,
            check_push_secret_health,
            store_push_context,
            load_push_context,
            save_mls_state,
            recharger_mls_au_resume,
            mls_foreground_heartbeat,
            pause_mls_foreground,
            delete_mls_state,
            load_mls_state,
            store_push_secret,
            clear_app_data,
            bootstrap_dead_conversation,
            set_native_flag,
            get_native_flags,
            read_and_clear_fcm_cache,
            store_outbox_mirror,
            read_and_clear_outbox_sent,
            store_channel_key
        ])
        .run(tauri::generate_context!())
        .unwrap_or_else(|e| {
            // Sur Android, log::error! est routé vers logcat (tag "CanariRust")
            // avant que le panic ne provoque le SIGABRT visible dans le crash log.
            #[cfg(target_os = "android")]
            log::error!("Tauri failed to start: {e:?}");
            panic!("error while running tauri application: {e:?}");
        });
}

// Point d'entrée JNI pour le Worker en arrière-plan
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "C" fn Java_fr_emse_canari_MlsBackgroundWorker_nativeProcessBackgroundTasks(
    mut env: jni::JNIEnv,
    _class: jni::objects::JClass,
    files_dir: jni::objects::JString,
    _state_bytes: jni::objects::JByteArray,
    _pin: jni::objects::JString,
    _user_id: jni::objects::JString,
    _device_id: jni::objects::JString,
) -> jni::sys::jboolean {
    // (B) Janitor : ce Worker ne DRAINE plus la file de gap (plus de chargement du manager ni
    // d'avancee de ratchet). Le drain background etait redondant avec la recuperation foreground
    // (resync serveur sur `GAP_QUEUED`) et NUISIBLE : il re-avancait le ratchet pour des messages
    // deja livres -> `SecretReuse`, et son avancee entrait en conflit avec le rechargement au
    // resume (C2). Il ne reste que le nettoyage anti-fuite de la table.
    let files_dir_str: String = match env.get_string(&files_dir) {
        Ok(s) => s.into(),
        Err(_) => return 0,
    };

    match mobile::background::cleanup_pending_db(std::path::Path::new(&files_dir_str)) {
        Ok(()) => {
            log::info!("Background Worker execute avec succes !");
            1
        }
        Err(e) => {
            log::error!("Background Worker echoue: {e}");
            0
        }
    }
}

/// Crée un paquet Welcome MLS pour un nouveau device (background service, app tuée).
///
/// Appelé depuis `CanariFirebaseMessagingService` lors de la réception d'un
/// `welcome_request_pending` FCM quand l'app n'est pas en premier plan.
///
/// - Charge l'état MLS depuis `state_bytes`.
/// - Appelle `add_member` avec le `key_package_b64` du requester.
/// - Sauvegarde l'état MLS mis à jour dans `{files_dir}/mls.bin`.
/// - Retourne un JSON : `{"ok":true,"welcome":"<b64>","ratchetTree":"<b64>|null","commit":"<b64>","baseEpoch":<u64>}`
///   ou `{"ok":false,"error":"…"}` en cas d'échec. `baseEpoch` est l'epoch AVANT l'ajout : le
///   backend le valide (validateCommit) pour garder son compteur en phase avec l'epoch reel (C6).
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "C" fn Java_fr_emse_canari_CanariFirebaseMessagingService_nativeCreateWelcomeBackground<
    'a,
>(
    mut env: jni::JNIEnv<'a>,
    _service: jni::objects::JObject<'a>,
    files_dir: jni::objects::JString<'a>,
    state_bytes: jni::objects::JByteArray<'a>,
    pin: jni::objects::JString<'a>,
    user_id: jni::objects::JString<'a>,
    device_id: jni::objects::JString<'a>,
    group_id: jni::objects::JString<'a>,
    key_package_b64: jni::objects::JString<'a>,
) -> jni::objects::JString<'a> {
    let result = (|| -> Result<serde_json::Value, String> {
        let files_dir_str: String = env
            .get_string(&files_dir)
            .map_err(|e| e.to_string())?
            .into();
        let state_vec = env
            .convert_byte_array(&state_bytes)
            .map_err(|e| e.to_string())?;
        let pin_str: String = env.get_string(&pin).map_err(|e| e.to_string())?.into();
        let user_id_str: String = env.get_string(&user_id).map_err(|e| e.to_string())?.into();
        let device_id_str: String = env
            .get_string(&device_id)
            .map_err(|e| e.to_string())?
            .into();
        let group_id_str: String = env.get_string(&group_id).map_err(|e| e.to_string())?.into();
        let kp_b64: String = env
            .get_string(&key_package_b64)
            .map_err(|e| e.to_string())?
            .into();

        mobile::background::create_welcome_background(
            std::path::Path::new(&files_dir_str),
            &state_vec,
            &pin_str,
            &user_id_str,
            &device_id_str,
            &group_id_str,
            &kp_b64,
        )
    })();

    let json_str = match result {
        Ok(v) => v.to_string(),
        Err(e) => {
            log::error!("[BG_WELCOME] nativeCreateWelcomeBackground failed: {e}");
            format!("{{\"ok\":false,\"error\":{:?}}}", e)
        }
    };

    env.new_string(&json_str)
        .unwrap_or_else(|_| env.new_string("{\"ok\":false}").unwrap())
}

/// Applique un Welcome MLS reçu en arrière-plan (côté RECEVEUR, app tuée) : rejoint le
/// groupe et persiste `mls.bin`. Miroir receveur de `nativeCreateWelcomeBackground`.
///
/// Sans ceci, le device ne rejoignait un nouveau groupe qu'à l'ouverture de l'app (moteur
/// foreground), si bien que le 1er message d'une conversation initiée pendant que l'app est
/// fermée restait indéchiffrable par FCM jusqu'à cette ouverture.
///
/// - `welcome_b64` : bytes du Welcome (base64).
/// - `ratchet_tree_b64` : ratchet tree (base64) ; chaîne vide ou "null" si absent.
/// - Retourne `1` en cas de succès, `0` sinon.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "C" fn Java_fr_emse_canari_CanariFirebaseMessagingService_nativeProcessWelcomeBackground(
    mut env: jni::JNIEnv,
    _service: jni::objects::JObject,
    files_dir: jni::objects::JString,
    state_bytes: jni::objects::JByteArray,
    pin: jni::objects::JString,
    user_id: jni::objects::JString,
    device_id: jni::objects::JString,
    welcome_b64: jni::objects::JString,
    ratchet_tree_b64: jni::objects::JString,
) -> jni::sys::jboolean {
    let result = (|| -> Result<(), String> {
        let files_dir_str: String = env
            .get_string(&files_dir)
            .map_err(|e| e.to_string())?
            .into();
        let state_vec = env
            .convert_byte_array(&state_bytes)
            .map_err(|e| e.to_string())?;
        let pin_str: String = env.get_string(&pin).map_err(|e| e.to_string())?.into();
        let user_id_str: String = env.get_string(&user_id).map_err(|e| e.to_string())?.into();
        let device_id_str: String = env
            .get_string(&device_id)
            .map_err(|e| e.to_string())?
            .into();
        let welcome_b64_str: String = env
            .get_string(&welcome_b64)
            .map_err(|e| e.to_string())?
            .into();
        let rt_b64_str: String = env
            .get_string(&ratchet_tree_b64)
            .map_err(|e| e.to_string())?
            .into();

        mobile::background::process_welcome_background(
            std::path::Path::new(&files_dir_str),
            &state_vec,
            &pin_str,
            &user_id_str,
            &device_id_str,
            &welcome_b64_str,
            &rt_b64_str,
        )
    })();

    match result {
        Ok(()) => 1,
        Err(e) => {
            log::error!("[BG_JOIN] nativeProcessWelcomeBackground failed: {e}");
            0
        }
    }
}

/// Builds a plaintext `AppMessage` text proto (base64) for a notification quick-reply (Android
/// RemoteInput action), without touching MLS state. The caller (Kotlin) appends the result as an
/// entry to `outbox_pending.ndjson` and drains it through the existing
/// `nativeSendMessageBackground`-based `drainOutboxBackground` - no new send path, only a new way
/// to produce the plaintext proto when the TS runtime that normally builds it is not alive.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_fr_emse_canari_CanariFirebaseMessagingService_nativeBuildTextMessageProto<
    'a,
>(
    mut env: jni::JNIEnv<'a>,
    _service: jni::objects::JObject<'a>,
    message_id: jni::objects::JString<'a>,
    sent_at: jni::sys::jlong,
    content: jni::objects::JString<'a>,
) -> jni::objects::JString<'a> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    let result = (|| -> Result<String, String> {
        let message_id_str: String = env
            .get_string(&message_id)
            .map_err(|e| e.to_string())?
            .into();
        let content_str: String = env.get_string(&content).map_err(|e| e.to_string())?.into();
        let bytes =
            mobile::proto_fields::build_text_app_message(&message_id_str, sent_at, &content_str);
        Ok(STANDARD.encode(&bytes))
    })();

    let out = result.unwrap_or_else(|e| {
        log::error!("[QUICK_REPLY] nativeBuildTextMessageProto failed: {e}");
        String::new()
    });
    env.new_string(&out)
        .unwrap_or_else(|_| env.new_string("").unwrap())
}

/// Builds a plaintext `AppMessage` read-receipt (system) proto (base64) for the "mark as read"
/// notification quick action. `message_ids_json` is a JSON array of message id strings (read from
/// `fcm_message_cache.ndjson` on the Kotlin side). Sent through the outbox drain like the reply
/// above, but marked `silent` by the caller so it triggers the existing cross-device
/// notification-cancel path instead of a peer push.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_fr_emse_canari_CanariFirebaseMessagingService_nativeBuildReadReceiptProto<
    'a,
>(
    mut env: jni::JNIEnv<'a>,
    _service: jni::objects::JObject<'a>,
    message_ids_json: jni::objects::JString<'a>,
) -> jni::objects::JString<'a> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    let result = (|| -> Result<String, String> {
        let json_str: String = env
            .get_string(&message_ids_json)
            .map_err(|e| e.to_string())?
            .into();
        let ids: Vec<String> = serde_json::from_str(&json_str).map_err(|e| e.to_string())?;
        let bytes = mobile::proto_fields::build_read_receipt_app_message(&ids);
        Ok(STANDARD.encode(&bytes))
    })();

    let out = result.unwrap_or_else(|e| {
        log::error!("[MARK_READ] nativeBuildReadReceiptProto failed: {e}");
        String::new()
    });
    env.new_string(&out)
        .unwrap_or_else(|_| env.new_string("").unwrap())
}

/// Chiffre et persiste un message sortant en attente (texte/reply) en arrière-plan (app tuée).
///
/// Pendant de l'envoi : charge l'état MLS, chiffre le proto AppMessage *en clair* (`proto_b64`)
/// contre l'epoch vivant via `MlsManager::send_message`, persiste `mls.bin`, et retourne le
/// ciphertext MLS (base64) que le service Kotlin POST à `/api/mls/push/send`.
///
/// - `proto_b64` : bytes du proto AppMessage en clair (base64), construits côté TS au compose.
/// - Retourne un JSON : `{"ok":true,"ciphertext":"<b64>"}` ou `{"ok":false,"error":"…"}`.
///   Un échec `GroupNotFound` (groupe pas encore rejoint) ressort en erreur : l'appelant laisse
///   l'entrée en file et la livrera au prochain foreground.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "C" fn Java_fr_emse_canari_CanariFirebaseMessagingService_nativeSendMessageBackground<
    'a,
>(
    mut env: jni::JNIEnv<'a>,
    _service: jni::objects::JObject<'a>,
    files_dir: jni::objects::JString<'a>,
    state_bytes: jni::objects::JByteArray<'a>,
    pin: jni::objects::JString<'a>,
    user_id: jni::objects::JString<'a>,
    device_id: jni::objects::JString<'a>,
    group_id: jni::objects::JString<'a>,
    proto_b64: jni::objects::JString<'a>,
) -> jni::objects::JString<'a> {
    let result = (|| -> Result<serde_json::Value, String> {
        let files_dir_str: String = env
            .get_string(&files_dir)
            .map_err(|e| e.to_string())?
            .into();
        let state_vec = env
            .convert_byte_array(&state_bytes)
            .map_err(|e| e.to_string())?;
        let pin_str: String = env.get_string(&pin).map_err(|e| e.to_string())?.into();
        let user_id_str: String = env.get_string(&user_id).map_err(|e| e.to_string())?.into();
        let device_id_str: String = env
            .get_string(&device_id)
            .map_err(|e| e.to_string())?
            .into();
        let group_id_str: String = env.get_string(&group_id).map_err(|e| e.to_string())?.into();
        let proto_b64_str: String = env
            .get_string(&proto_b64)
            .map_err(|e| e.to_string())?
            .into();

        mobile::background::send_message_background(
            std::path::Path::new(&files_dir_str),
            &state_vec,
            &pin_str,
            &user_id_str,
            &device_id_str,
            &group_id_str,
            &proto_b64_str,
        )
    })();

    let json_str = match result {
        Ok(v) => v.to_string(),
        Err(e) => {
            log::error!("[BG_SEND] nativeSendMessageBackground failed: {e}");
            format!("{{\"ok\":false,\"error\":{:?}}}", e)
        }
    };

    env.new_string(&json_str)
        .unwrap_or_else(|_| env.new_string("{\"ok\":false}").unwrap())
}
