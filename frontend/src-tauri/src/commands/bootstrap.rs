//! Commande Tauri de re-bootstrap (Fail-Safe) pour recreer un groupe MLS mort.

use crate::concurrency::write_mls_state_blob;
use crate::state::{AppState, HttpClient, PendingDb};
use base64::Engine as _;

/// Resultat du bootstrap retourne au frontend TypeScript.
#[derive(serde::Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub(crate) enum BootstrapOutcome {
    /// Bootstrap reussi : le frontend doit envoyer les Welcome + le commit.
    Success {
        commit: Vec<u8>,
        welcome: Option<Vec<u8>>,
        added_device_ids: Vec<String>,
        ratchet_tree: Option<Vec<u8>>,
        new_bootstrap_version: u32,
    },
    /// Race condition : un autre device a deja bootstrappe le groupe.
    /// Le frontend doit ignorer et attendre le Welcome entrant.
    Conflict,
    /// Aucun device tiers a inviter (groupe solo ou tous hors-ligne).
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

/// Fail-Safe universel : recree un groupe MLS mort de zero.
///
/// Sequence atomique du point de vue du reseau :
///   1. Acquiert le verrou optimiste cote serveur (`claim-bootstrap`).
///      Si 409 -> un autre device a gagne la course -> retourne Conflict.
///   2. Remet l'epoch serveur a 0 (`reset-epoch`).
///   3. Cree un etat MLS frais en local (`force_create_group`).
///   4. Recupere les KeyPackages de tous les membres via l'API.
///   5. Ajoute tous les devices en bulk (`add_members_bulk`).
///   6. Sauvegarde l'etat MLS chiffre (mls.bin + checkpoint SQLite).
///   7. Remet a zero le compteur de defaillances consecutives.
///
/// La completion (envoi du Welcome + commit) est laissee au frontend TypeScript
/// car elle implique de multiples appels reseau et de la logique applicative.
#[tauri::command]
pub(crate) async fn bootstrap_dead_conversation(
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
    // --- Etape 1 : Acquerir le verrou optimiste --------------------------------
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
            "[BOOTSTRAP] Race condition detectee pour group={} - un autre device a deja bootstrappe.",
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

    // --- Etape 2 : Reset de l'epoch serveur a 0 -------------------------------
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
            "[BOOTSTRAP] reset-epoch failed ({}) - on continue quand meme.",
            reset_resp.status()
        );
    }

    // --- Etape 3 : Creer un etat MLS frais en local ---------------------------
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

    // --- Etape 4 : Recuperer les KeyPackages de chaque membre -----------------
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
                log::warn!(
                    "[BOOTSTRAP] fetchUserDevices({}) -> {}",
                    user_id,
                    r.status()
                );
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
            "[BOOTSTRAP] Aucun KeyPackage valide pour group={} - bootstrap annule.",
            conversation_id
        );
        return Ok(BootstrapOutcome::NoMembers);
    }

    // --- Etape 5 : Ajouter tous les devices en bulk ---------------------------
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

    // --- Etape 6 : Sauvegarder l'etat MLS ------------------------------------
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
        "[BOOTSTRAP] Groupe {} re-bootstrappe avec succes ({} devices).",
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
