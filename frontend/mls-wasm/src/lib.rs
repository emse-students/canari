use mls_core::MlsManager;
use wasm_bindgen::prelude::*;

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
    pub fn new(user_id: &str, state_bytes: Option<Vec<u8>>, pin: Option<String>) -> Result<WasmMlsClient, JsValue> {
        // Rediriger les erreurs panics Rust vers la console du navigateur
        console_error_panic_hook::set_once();

        let manager = if let (Some(blob), Some(p)) = (state_bytes.clone(), pin) {
             MlsManager::load_encrypted(user_id, Some(blob), &p)
                .map_err(|e| JsValue::from_str(&e.to_string()))?
        } else {
             MlsManager::load_or_create(user_id, state_bytes)
                .map_err(|e| JsValue::from_str(&e.to_string()))?
        };

        Ok(WasmMlsClient { manager })
    }

    // Créer un groupe
    #[wasm_bindgen]
    pub fn create_group(&mut self, group_id: String) -> Result<(), JsValue> {
        self.manager.create_group(group_id)
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    // Sauvegarder l'état (renvoie un Uint8Array en JS)
    #[wasm_bindgen]
    pub fn save_state(&self) -> Result<Vec<u8>, JsValue> {
        self.manager.save_state()
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    #[wasm_bindgen]
    pub fn generate_key_package(&self) -> Result<Vec<u8>, JsValue> {
        self.manager.generate_key_package()
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    #[wasm_bindgen]
    pub fn add_member(&mut self, group_id: String, key_package_bytes: Vec<u8>) -> Result<js_sys::Array, JsValue> {
        let (commit, welcome) = self.manager.add_member(&group_id, &key_package_bytes)
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

    #[wasm_bindgen]
    pub fn process_welcome(&mut self, welcome_bytes: Vec<u8>) -> Result<String, JsValue> {
        self.manager.process_welcome(&welcome_bytes, None)
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    #[wasm_bindgen]
    pub fn send_message(&mut self, group_id: String, message: String) -> Result<Vec<u8>, JsValue> {
         self.manager.send_message(&group_id, message.as_bytes())
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    #[wasm_bindgen]
    pub fn process_incoming_message(&mut self, group_id: String, message_bytes: Vec<u8>) -> Result<Option<String>, JsValue> {
        let res = self.manager.process_incoming_message(&group_id, &message_bytes)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        
        match res {
            Some(bytes) => Ok(Some(String::from_utf8_lossy(&bytes).to_string())),
            None => Ok(None)
        }
    }
}