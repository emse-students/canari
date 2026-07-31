//! Re-bootstrap (fail-safe) Tauri command, used to recreate a dead MLS group.

use crate::concurrency::write_mls_state_blob;
use crate::state::{AppState, HttpClient, PendingDb};
use base64::Engine as _;

/// Bootstrap result returned to the TypeScript frontend.
#[derive(serde::Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub(crate) enum BootstrapOutcome {
    /// Bootstrap succeeded: the frontend must send the Welcomes plus the commit.
    Success {
        commit: Vec<u8>,
        welcome: Option<Vec<u8>>,
        added_device_ids: Vec<String>,
        ratchet_tree: Option<Vec<u8>>,
        new_bootstrap_version: u32,
    },
    /// Race condition: another device already bootstrapped the group.
    /// The frontend must ignore this and wait for the incoming Welcome.
    Conflict,
    /// No third-party device to invite (solo group, or all of them offline).
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

/// Universal fail-safe: rebuilds a dead MLS group from scratch.
///
/// Network-atomic sequence:
///   1. Acquire the server-side optimistic lock (`claim-bootstrap`).
///      On 409 -> another device won the race -> return Conflict.
///   2. Reset the server epoch to 0 (`reset-epoch`).
///   3. Create a fresh local MLS state (`force_create_group`).
///   4. Fetch every member's KeyPackages through the API.
///   5. Add all devices in bulk (`add_members_bulk`).
///   6. Save the encrypted MLS state (mls.bin + SQLite checkpoint).
///   7. Reset the consecutive-failure counter.
///
/// Completion (sending the Welcome + commit) is left to the TypeScript frontend because it
/// involves multiple network calls and application-level logic.
///
/// The argument count is fixed by the Tauri IPC signature (the last four are injected by the
/// runtime, not passed by the caller), so grouping them into a struct would only obscure it.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub(crate) async fn bootstrap_dead_conversation(
    conversation_id: String,
    member_user_ids: Vec<String>,
    expected_bootstrap_version: u32,
    auth_token: String,
    base_url: String,
    device_key_b64: String,
    state: tauri::State<'_, AppState>,
    pending_db: tauri::State<'_, PendingDb>,
    http_client: tauri::State<'_, HttpClient>,
    app: tauri::AppHandle,
) -> Result<BootstrapOutcome, String> {
    // --- Step 1: acquire the optimistic lock -----------------------------------
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
            "[BOOTSTRAP] Race detected for group={} - another device has already bootstrapped.",
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

    // --- Step 2: reset the server epoch to 0 -----------------------------------
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

    // --- Step 3: create a fresh local MLS state --------------------------------
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

    // --- Step 4: fetch every member's KeyPackages ------------------------------
    // All HTTP calls happen OUTSIDE the Mutex (never await under the lock).
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
            "[BOOTSTRAP] No valid KeyPackage for group={} - bootstrap cancelled.",
            conversation_id
        );
        return Ok(BootstrapOutcome::NoMembers);
    }

    // --- Step 5: add every device in bulk --------------------------------------
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
                "[BOOTSTRAP] {} invalid KeyPackage(s) skipped for group={} (indices {:?}) - those device(s) were not re-invited. [[C5]]",
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

    // --- Step 6: persist the MLS state -----------------------------------------
    let enc = {
        let lock = state
            .mls_manager
            .lock()
            .map_err(|_| "Failed to lock state")?;
        let manager = lock.as_ref().ok_or("MLS Manager not initialized")?;
        let key = mls_core::crypto::decode_base64_to_32_bytes(&device_key_b64)
            .map_err(|e| format!("invalid device_key_b64: {e}"))?;
        manager
            .save_encrypted_with_key(&key)
            .map_err(|e| e.to_string())?
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
        "[BOOTSTRAP] Group {} re-bootstrapped successfully ({} devices).",
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
