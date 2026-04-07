// WS message dispatch — types shared between handlers.rs and this file.
//
// All send-path operations (mls, commit, welcome) and signalling requests
// (welcome_request, reinvite_request) now go directly from the frontend to
// the delivery service via HTTP.  The gateway WS connection is receive-only
// for those message types.
//
// Remaining inbound frame types:
//   • read — no-op  (read receipts are handled at the application layer)

use std::sync::Arc;
use tokio::sync::mpsc;

use crate::state::AppState;

// ── Connection context (one per WebSocket session) ────────────────────────

pub struct WsConn<'a> {
    pub state: &'a Arc<AppState>,
    pub user_id: &'a str,
    pub device_id: &'a str,
    /// Channel to push frames back to this client.
    pub tx: &'a mpsc::Sender<String>,
}

// ── Parsed incoming frame ─────────────────────────────────────────────────

pub struct WsFrame {
    pub msg_type: String,
    pub group_id: String,
}

impl WsFrame {
    /// Parse a raw JSON value into a `WsFrame`.
    pub fn parse(json: &serde_json::Value) -> Option<Self> {
        let msg_type = json
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let group_id = json
            .get("groupId")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();

        Some(WsFrame { msg_type, group_id })
    }
}
