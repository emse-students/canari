//! The JavaScript face of [`crate::MailTls`] (wasm-bindgen).

use wasm_bindgen::prelude::*;

use crate::{MailTls, MailTlsError};

/// A [`MailTlsError`] as JavaScript receives it: an `Error` named `MailTlsError` whose `kind` is
/// the stable code ([`crate::MailTlsErrorKind::code`]) - the field the caller classifies on.
fn to_js(e: MailTlsError) -> JsValue {
    let error = js_sys::Error::new(&e.to_string());
    error.set_name("MailTlsError");
    // Setting a property on a fresh Error cannot fail.
    let _ = js_sys::Reflect::set(&error, &"kind".into(), &e.kind.code().into());
    error.into()
}

/// One TLS session to `partage.emse.fr`, driven by the page (see the crate documentation).
#[wasm_bindgen]
pub struct MailTlsClient {
    inner: MailTls,
}

#[wasm_bindgen]
impl MailTlsClient {
    /// A new session; its ClientHello is waiting in `takeCiphertext()`.
    #[wasm_bindgen(constructor)]
    pub fn new() -> Result<MailTlsClient, JsValue> {
        Ok(MailTlsClient {
            inner: MailTls::new().map_err(to_js)?,
        })
    }

    /// Hands the session bytes that arrived from the server. Throws a `MailTlsError`.
    #[wasm_bindgen(js_name = feedCiphertext)]
    pub fn feed_ciphertext(&mut self, bytes: &[u8]) -> Result<(), JsValue> {
        self.inner.feed_ciphertext(bytes).map_err(to_js)
    }

    /// The bytes owed to the server, empty when none.
    #[wasm_bindgen(js_name = takeCiphertext)]
    pub fn take_ciphertext(&mut self) -> Vec<u8> {
        self.inner.take_ciphertext()
    }

    /// Queues plaintext to send. Throws a `MailTlsError` of kind `closed` after a close.
    #[wasm_bindgen(js_name = writePlaintext)]
    pub fn write_plaintext(&mut self, data: &[u8]) -> Result<(), JsValue> {
        self.inner.write_plaintext(data).map_err(to_js)
    }

    /// The plaintext received and not yet read, empty when none.
    #[wasm_bindgen(js_name = readPlaintext)]
    pub fn read_plaintext(&mut self) -> Vec<u8> {
        self.inner.read_plaintext()
    }

    /// Whether the handshake is still running.
    #[wasm_bindgen(js_name = isHandshaking)]
    pub fn is_handshaking(&self) -> bool {
        self.inner.is_handshaking()
    }

    /// Whether the server sent its close_notify.
    #[wasm_bindgen(js_name = peerClosed)]
    pub fn peer_closed(&self) -> bool {
        self.inner.peer_closed()
    }

    /// Ends the session; the close_notify is waiting in `takeCiphertext()`.
    pub fn close(&mut self) {
        self.inner.close();
    }
}
