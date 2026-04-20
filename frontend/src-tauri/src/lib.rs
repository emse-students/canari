// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use mls_core::MlsManager;
use std::sync::Mutex;

use tauri::Manager;

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
use tauri::{
    image::Image,
    menu::{MenuBuilder, MenuItemBuilder},
    tray::TrayIconBuilder,
    WindowEvent,
};

// State wrapper
struct AppState {
    mls_manager: Mutex<Option<MlsManager>>,
}

// --- COMMANDS ---

#[tauri::command]
fn initialiser_mls(
    user_id: String,
    device_id: String,
    pin: String,
    encrypted_state: Option<Vec<u8>>,
    state: tauri::State<AppState>,
) -> Result<String, String> {
    let manager = MlsManager::load_encrypted(&user_id, &device_id, encrypted_state, &pin)
        .map_err(|e| e.to_string())?;

    let mut lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    *lock = Some(manager);

    Ok("MLS Initialized".into())
}

#[tauri::command]
fn sauvegarder_mls(pin: String, state: tauri::State<AppState>) -> Result<Vec<u8>, String> {
    let lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_ref().ok_or("MLS Manager not initialized")?;

    manager.save_encrypted(&pin).map_err(|e| e.to_string())
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
fn generer_key_package(state: tauri::State<AppState>) -> Result<Vec<u8>, String> {
    let lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_ref().ok_or("MLS Manager not initialized")?;

    manager.generate_key_package().map_err(|e| e.to_string())
}

#[tauri::command]
fn generer_key_packages(
    count: usize,
    state: tauri::State<AppState>,
) -> Result<Vec<Vec<u8>>, String> {
    let lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_ref().ok_or("MLS Manager not initialized")?;

    manager
        .generate_key_packages(count)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn oublier_groupe(
    group_id: String,
    min_epoch: u32,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let mut lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_mut().ok_or("MLS Manager not initialized")?;
    manager.forget_group(&group_id, min_epoch as u64);
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
fn obtenir_epoch(group_id: String, state: tauri::State<AppState>) -> Result<u32, String> {
    let lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_ref().ok_or("MLS Manager not initialized")?;
    let epoch = manager.get_epoch(&group_id).map_err(|e| e.to_string())?;
    Ok(epoch as u32)
}

#[tauri::command]
fn ajouter_membre(
    group_id: String,
    key_package_bytes: Vec<u8>,
    state: tauri::State<AppState>,
) -> Result<(Vec<u8>, Option<Vec<u8>>, Option<Vec<u8>>), String> {
    let mut lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_mut().ok_or("MLS Manager not initialized")?;

    manager
        .add_member(&group_id, &key_package_bytes)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn ajouter_membres_bulk(
    group_id: String,
    key_packages_bytes: Vec<Vec<u8>>,
    state: tauri::State<AppState>,
) -> Result<(Vec<u8>, Option<Vec<u8>>, usize, Option<Vec<u8>>), String> {
    let mut lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_mut().ok_or("MLS Manager not initialized")?;

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
        .map_err(|e| e.to_string())
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
        .map_err(|e| e.to_string())?;

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

#[tauri::command]
fn recevoir_message_bytes(
    group_id: String,
    message_bytes: Vec<u8>,
    state: tauri::State<AppState>,
) -> Result<Option<Vec<u8>>, String> {
    let mut lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_mut().ok_or("MLS Manager not initialized")?;

    manager
        .process_incoming_message(&group_id, &message_bytes)
        .map_err(|e| e.to_string())
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

/// Sauvegarde un fichier binaire sur le système de fichiers de l'appareil.
/// Sur desktop : écrit dans le dossier Téléchargements (~/Downloads).
/// Sur mobile  : écrit dans le répertoire privé de l'application.
/// Retourne le chemin absolu du fichier créé.
#[tauri::command]
fn save_backup_file(
    app: tauri::AppHandle,
    filename: String,
    data: Vec<u8>,
) -> Result<String, String> {
    use tauri::Manager;

    // Validate filename: no path separators, no null bytes, not empty.
    if filename.is_empty()
        || filename.contains('/')
        || filename.contains('\\')
        || filename.contains('\0')
    {
        return Err("Nom de fichier invalide.".into());
    }

    let dir = app
        .path()
        .download_dir()
        .or_else(|_| app.path().app_data_dir())
        .map_err(|e| format!("Impossible de trouver le dossier de destination: {}", e))?;

    std::fs::create_dir_all(&dir).map_err(|e| format!("Impossible de créer le dossier: {}", e))?;

    let file_path = dir.join(&filename);
    std::fs::write(&file_path, &data)
        .map_err(|e| format!("Impossible d'écrire le fichier: {}", e))?;

    Ok(file_path.to_string_lossy().into_owned())
}

/// Retourne le token FCM stocké par CanariFirebaseMessagingService.
/// Sur Android, lit {app_data_dir}/fcm_token.txt (écrit par onNewToken).
/// Sur desktop/iOS, retourne None (pas de FCM).
#[tauri::command]
fn get_fcm_token(app: tauri::AppHandle) -> Option<String> {
    #[cfg(target_os = "android")]
    {
        let data_dir = app.path().app_data_dir().ok()?;
        let token = std::fs::read_to_string(data_dir.join("fcm_token.txt")).ok()?;
        let token = token.trim().to_string();
        if token.is_empty() {
            None
        } else {
            Some(token)
        }
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        None
    }
}

// ─── Protobuf minimal helpers (pas de dépendance externe) ────────────────────

/// Lit un varint protobuf depuis `bytes` à la position `pos`.
/// Retourne (valeur, position_suivante) ou None si invalide.
#[cfg(target_os = "android")]
fn read_varint(bytes: &[u8], pos: usize) -> Option<(u64, usize)> {
    let mut result: u64 = 0;
    let mut shift = 0u32;
    let mut cur = pos;
    loop {
        if cur >= bytes.len() || shift >= 64 {
            return None;
        }
        let byte = bytes[cur] as u64;
        result |= (byte & 0x7f) << shift;
        cur += 1;
        if byte & 0x80 == 0 {
            break;
        }
        shift += 7;
    }
    Some((result, cur))
}

/// Cherche le premier champ `field_num` de wire type 2 (LEN) dans `bytes`.
/// Retourne les octets du payload de ce champ, ou None si absent.
#[cfg(target_os = "android")]
fn find_length_delimited_field(bytes: &[u8], field_num: u32) -> Option<Vec<u8>> {
    let mut pos = 0usize;
    while pos < bytes.len() {
        let (tag, after_tag) = read_varint(bytes, pos)?;
        let wire_type = tag & 0x7;
        let field = (tag >> 3) as u32;
        pos = after_tag;
        match wire_type {
            0 => {
                let (_, next) = read_varint(bytes, pos)?;
                pos = next;
            }
            1 => {
                if pos + 8 > bytes.len() {
                    return None;
                }
                pos += 8;
            }
            2 => {
                let (len, after_len) = read_varint(bytes, pos)?;
                pos = after_len;
                let end = pos + len as usize;
                if end > bytes.len() {
                    return None;
                }
                if field == field_num {
                    return Some(bytes[pos..end].to_vec());
                }
                pos = end;
            }
            5 => {
                if pos + 4 > bytes.len() {
                    return None;
                }
                pos += 4;
            }
            _ => return None,
        }
    }
    None
}

/// Extrait le texte d'un `AppMessage` protobuf déchiffré.
/// - field 1 = TextMsg  (.content = field 1)
/// - field 2 = ReplyMsg (.content = field 1)
/// - field 4 = MediaMsg → texte générique
#[cfg(target_os = "android")]
fn extract_app_message_text(bytes: &[u8]) -> Option<String> {
    // TextMsg
    if let Some(text_msg) = find_length_delimited_field(bytes, 1) {
        if let Some(content) = find_length_delimited_field(&text_msg, 1) {
            if let Ok(s) = String::from_utf8(content) {
                if !s.is_empty() {
                    return Some(s);
                }
            }
        }
    }
    // ReplyMsg
    if let Some(reply_msg) = find_length_delimited_field(bytes, 2) {
        if let Some(content) = find_length_delimited_field(&reply_msg, 1) {
            if let Ok(s) = String::from_utf8(content) {
                if !s.is_empty() {
                    return Some(s);
                }
            }
        }
    }
    // MediaMsg
    if find_length_delimited_field(bytes, 4).is_some() {
        return Some("📎 Pièce jointe".to_string());
    }
    None
}

// ─── Fonction JNI appelée par CanariFirebaseMessagingService ─────────────────

/// Déchiffre un message MLS et extrait son texte.
/// Appelée directement depuis Kotlin via System.loadLibrary("mines_app_lib").
/// Retourne le texte du message, ou "" si le déchiffrement échoue.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_fr_emse_canari_CanariFirebaseMessagingService_nativeDecryptMessage<
    'a,
>(
    mut env: jni::JNIEnv<'a>,
    _service: jni::objects::JObject<'a>,
    state_bytes: jni::objects::JByteArray<'a>,
    pin: jni::objects::JString<'a>,
    group_id: jni::objects::JString<'a>,
    ciphertext: jni::objects::JByteArray<'a>,
) -> jni::objects::JString<'a> {
    let text = (|| -> Option<String> {
        let state_vec = env.convert_byte_array(&state_bytes).ok()?;
        let pin_str: String = env.get_string(&pin).ok()?.into();
        let group_id_str: String = env.get_string(&group_id).ok()?.into();
        let cipher_vec = env.convert_byte_array(&ciphertext).ok()?;

        // Crée un MlsManager temporaire depuis l'état sauvegardé (lecture seule du fichier).
        // Ce manager TEMPORAIRE avance son propre ratchet mais n'écrit rien sur disque.
        // Le MlsManager de l'app principale peut donc traiter le même message normalement.
        let mut manager =
            MlsManager::load_encrypted("_push_", "_push_", Some(state_vec), &pin_str).ok()?;

        let plaintext = manager
            .process_incoming_message(&group_id_str, &cipher_vec)
            .ok()??;

        extract_app_message_text(&plaintext)
    })()
    .unwrap_or_default();

    env.new_string(&text)
        .unwrap_or_else(|_| env.new_string("").unwrap())
}

// ─── Commandes Tauri : contexte push ─────────────────────────────────────────

/// Sauvegarde le PIN et le contexte de session dans {app_data_dir}/push_context.json
/// pour que CanariFirebaseMessagingService puisse déchiffrer les notifications push.
#[tauri::command]
fn store_push_context(
    pin: String,
    user_id: String,
    device_id: String,
    base_url: String,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    let json = serde_json::json!({
        "pin": pin,
        "userId": user_id,
        "deviceId": device_id,
        "baseUrl": base_url
    });
    std::fs::write(data_dir.join("push_context.json"), json.to_string()).map_err(|e| e.to_string())
}

/// Chiffre l'état MLS courant et l'écrit dans {app_data_dir}/mls_push.bin
/// pour que CanariFirebaseMessagingService puisse le lire.
#[tauri::command]
fn save_mls_state_for_push(
    pin: String,
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let encrypted_bytes = {
        let lock = state
            .mls_manager
            .lock()
            .map_err(|_| "Failed to lock state")?;
        let manager = lock.as_ref().ok_or("MLS not initialized")?;
        manager.save_encrypted(&pin).map_err(|e| e.to_string())?
    };
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    std::fs::write(data_dir.join("mls_push.bin"), &encrypted_bytes).map_err(|e| e.to_string())
}

// ─────────────────────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_sql::Builder::default().build());

    // Desktop-only: single-instance ensures the OS sends deep links to the
    // already-running instance instead of spawning a new process (Linux/Windows).
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_single_instance::init(|_app, _args, _cwd| {}))
        .plugin(tauri_plugin_deep_link::init());

    #[cfg(mobile)]
    let builder = builder
        .plugin(tauri_plugin_biometric::init())
        .plugin(tauri_plugin_keystore::init());

    builder
        .manage(AppState {
            mls_manager: Mutex::new(None),
        })
        .setup(|app| {
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
            creer_groupe,
            lister_groupes,
            oublier_groupe,
            obtenir_epoch,
            generer_key_package,
            generer_key_packages,
            ajouter_membre,
            ajouter_membres_bulk,
            retirer_membres,
            retirer_membres_par_appareil,
            trailer_welcome,
            envoyer_message,
            envoyer_message_bytes,
            recevoir_message,
            recevoir_message_bytes,
            exporter_secret,
            get_fcm_token,
            save_backup_file,
            store_push_context,
            save_mls_state_for_push
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
