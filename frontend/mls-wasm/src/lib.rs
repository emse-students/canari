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
    pub fn new(user_id: &str, decrypted_state: Option<Vec<u8>>) -> Result<WasmMlsClient, JsValue> {
        // Rediriger les erreurs panics Rust vers la console du navigateur
        console_error_panic_hook::set_once();

        let manager = MlsManager::load_or_create(user_id, decrypted_state)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;

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
}