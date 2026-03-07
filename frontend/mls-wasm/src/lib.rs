use log::{Level, Metadata, Record};
use mls_core::MlsManager;
use wasm_bindgen::prelude::*;

// --- Custom Logger that calls JS function `window.wasm_bindings_log(level, msg)` ---

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = window, js_name = wasm_bindings_log)]
    fn js_log(level: &str, s: &str);
}

struct WebLogger;

impl log::Log for WebLogger {
    fn enabled(&self, metadata: &Metadata) -> bool {
        metadata.level() <= Level::Debug
    }

    fn log(&self, record: &Record) {
        if self.enabled(record.metadata()) {
            js_log(&record.level().to_string(), &format!("{}", record.args()));
        }
    }

    fn flush(&self) {}
}

static LOGGER: WebLogger = WebLogger;

// Call this once from JS
#[wasm_bindgen]
pub fn init_logger() {
    // Attempt to init logger. If fails (already init), ignore.
    let _ = log::set_logger(&LOGGER).map(|()| log::set_max_level(log::LevelFilter::Debug));
}

// ----------------------------------------------------

// On crée une structure "Wrapper" exposée à JavaScript
#[wasm_bindgen]
pub struct WasmMlsClient {
    // Le manager vit à l'intérieur de l'instance WASM
    manager: MlsManager,
}

#[wasm_bindgen]
impl WasmMlsClient {
    // Constructeur appelé depuis JavaScript (ex: new WasmMlsClient(...))
    #[wasm_bindgen(constructor)]
    pub fn new(
        user_id: &str,
        state_bytes: Option<Vec<u8>>,
        pin: Option<String>,
    ) -> Result<WasmMlsClient, JsValue> {
        // Rediriger les erreurs panics Rust vers la console du navigateur
        console_error_panic_hook::set_once();

        // We assume init_logger() was called, but we can log here too.
        log::info!("WasmMlsClient::new called for user: {}", user_id);

        let manager = if let (Some(blob), Some(p)) = (state_bytes.clone(), pin) {
            log::info!("Loading encrypted state");
            MlsManager::load_encrypted(user_id, Some(blob), &p)
                .map_err(|e| JsValue::from_str(&e.to_string()))?
        } else {
            log::info!("Loading/Creating clean state");
            MlsManager::load_or_create(user_id, state_bytes)
                .map_err(|e| JsValue::from_str(&e.to_string()))?
        };

        Ok(WasmMlsClient { manager })
    }

    // Créer un groupe
    #[wasm_bindgen]
    pub fn create_group(&mut self, group_id: String) -> Result<(), JsValue> {
        log::info!("create_group: {}", group_id);
        self.manager
            .create_group(group_id)
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    #[wasm_bindgen]
    pub fn get_groups(&self) -> js_sys::Array {
        let groups = self.manager.get_known_groups();
        let arr = js_sys::Array::new();
        for g in groups {
            arr.push(&JsValue::from_str(&g));
        }
        arr
    }

    // Sauvegarder l'état (renvoie un Uint8Array en JS)
    #[wasm_bindgen]
    pub fn save_state(&self, pin: Option<String>) -> Result<Vec<u8>, JsValue> {
        // If PIN is provided, encrypt. Otherwise save plain (legacy/dev).
        if let Some(p) = pin {
            self.manager
                .save_encrypted(&p)
                .map_err(|e| JsValue::from_str(&e.to_string()))
        } else {
            self.manager
                .save_state()
                .map_err(|e| JsValue::from_str(&e.to_string()))
        }
    }

    #[wasm_bindgen]
    pub fn generate_key_package(&self) -> Result<Vec<u8>, JsValue> {
        log::info!("generate_key_package");
        self.manager
            .generate_key_package()
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    #[wasm_bindgen]
    pub fn add_member(
        &mut self,
        group_id: String,
        key_package_bytes: Vec<u8>,
    ) -> Result<js_sys::Array, JsValue> {
        log::info!(
            "add_member to group: {} ({} bytes)",
            group_id,
            key_package_bytes.len()
        );
        let (commit, welcome) = self
            .manager
            .add_member(&group_id, &key_package_bytes)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;

        let array = js_sys::Array::new();
        array.push(&js_sys::Uint8Array::from(&commit[..]));
        if let Some(w) = welcome {
            array.push(&js_sys::Uint8Array::from(&w[..]));
        } else {
            array.push(&JsValue::UNDEFINED);
        }
        Ok(array)
    }

    /// Add multiple members in a single commit (single epoch increment).
    /// `key_packages` is a JS Array of Uint8Array.
    /// Returns [commit: Uint8Array, welcome: Uint8Array, added_count: number].
    #[wasm_bindgen]
    pub fn add_members_bulk(
        &mut self,
        group_id: String,
        key_packages: js_sys::Array,
    ) -> Result<js_sys::Array, JsValue> {
        log::info!(
            "add_members_bulk to group: {} ({} key packages)",
            group_id,
            key_packages.length()
        );

        // Convert JS Array<Uint8Array> -> Vec<Vec<u8>>
        let kp_vecs: Vec<Vec<u8>> = key_packages
            .iter()
            .filter_map(|v| {
                let arr = js_sys::Uint8Array::from(v);
                if arr.length() == 0 {
                    None
                } else {
                    Some(arr.to_vec())
                }
            })
            .collect();

        let kp_slices: Vec<&[u8]> = kp_vecs.iter().map(|v| v.as_slice()).collect();

        let (commit, welcome, added) = self
            .manager
            .add_members_bulk(&group_id, &kp_slices)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;

        let array = js_sys::Array::new();
        array.push(&js_sys::Uint8Array::from(&commit[..]));
        if let Some(w) = welcome {
            array.push(&js_sys::Uint8Array::from(&w[..]));
        } else {
            array.push(&JsValue::UNDEFINED);
        }
        array.push(&JsValue::from_f64(added as f64));
        Ok(array)
    }

    #[wasm_bindgen]
    pub fn process_welcome(&mut self, welcome_bytes: Vec<u8>) -> Result<String, JsValue> {
        log::info!("process_welcome ({} bytes)", welcome_bytes.len());
        self.manager
            .process_welcome(&welcome_bytes, None)
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    #[wasm_bindgen]
    pub fn send_message(&mut self, group_id: String, message: String) -> Result<Vec<u8>, JsValue> {
        log::info!(
            "send_message to group: {} (len: {})",
            group_id,
            message.len()
        );
        self.manager
            .send_message(&group_id, message.as_bytes())
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    #[wasm_bindgen]
    pub fn process_incoming_message(
        &mut self,
        group_id: String,
        message_bytes: Vec<u8>,
    ) -> Result<Option<String>, JsValue> {
        log::info!(
            "process_incoming_message for group: {} ({} bytes)",
            group_id,
            message_bytes.len()
        );
        let res = self
            .manager
            .process_incoming_message(&group_id, &message_bytes)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;

        match res {
            Some(bytes) => Ok(Some(String::from_utf8_lossy(&bytes).to_string())),
            None => Ok(None),
        }
    }
}

// Security Utilities (Encryption at Rest)
// Uses the same logic as MLS Core (Argon2 + ChaCha20Poly1305)

#[wasm_bindgen]
pub fn encrypt_with_pin(pin: &str, data: &[u8]) -> Result<Vec<u8>, JsValue> {
    let mut salt = [0u8; 16];
    getrandom::getrandom(&mut salt).map_err(|e| JsValue::from_str(&e.to_string()))?;

    let key =
        mls_core::security::derive_key_from_pin(pin, &salt).map_err(|e| JsValue::from_str(&e))?;

    let nonce_ciphertext =
        mls_core::security::encrypt_blob(&key, data).map_err(|e| JsValue::from_str(&e))?;

    let mut result = Vec::new();
    result.extend_from_slice(&salt);
    result.extend_from_slice(&nonce_ciphertext);
    Ok(result)
}

#[wasm_bindgen]
pub fn decrypt_with_pin(pin: &str, encrypted_data: &[u8]) -> Result<Vec<u8>, JsValue> {
    if encrypted_data.len() < 16 + 12 {
        return Err(JsValue::from_str("Invalid encrypted data length"));
    }

    let (salt, rest) = encrypted_data.split_at(16);

    let key =
        mls_core::security::derive_key_from_pin(pin, salt).map_err(|e| JsValue::from_str(&e))?;

    let plaintext =
        mls_core::security::decrypt_blob(&key, rest).map_err(|e| JsValue::from_str(&e))?;

    Ok(plaintext)
}
