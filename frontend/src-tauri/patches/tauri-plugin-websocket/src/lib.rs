// Copyright 2019-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

//! Open a WebSocket connection using a Rust client in JS.
//!
//! ## Cargo features
//!
//! - **rustls-tls** *(enabled by default)*: Enables TLS functionality provided by `rustls` with WebPKI roots.
//! - **rustls-tls-native-roots**: Enables TLS functionality provided by `rustls` with the platform's native certificate roots.
//! - **native-tls**: Enables TLS functionality provided by `native-tls`.
//! - **native-tls-vendored**: Enables the `vendored` feature of `native-tls`.
//!
//! At least one TLS feature is required for `wss://`; plain `ws://` works without one.

#![doc(
    html_logo_url = "https://github.com/tauri-apps/tauri/raw/dev/app-icon.png",
    html_favicon_url = "https://github.com/tauri-apps/tauri/raw/dev/app-icon.png"
)]

use futures_util::{SinkExt, StreamExt, stream::SplitSink};
use http::header::{HeaderName, HeaderValue};
use serde::{Deserialize, Serialize, ser::Serializer};
use tauri::{
    Manager, Runtime, State, Window,
    ipc::Channel,
    plugin::{Builder as PluginBuilder, TauriPlugin},
};
use tokio::{net::TcpStream, sync::Mutex};
// CANARI PATCH: upstream imported `connect_async_tls_with_config` / `connect_async_with_config`
// here; both run tokio-tungstenite's sequential `TcpStream::connect` and are no longer called.
use tokio_tungstenite::{
    Connector, MaybeTlsStream, WebSocketStream,
    tungstenite::{
        Message,
        client::IntoClientRequest,
        protocol::{CloseFrame as ProtocolCloseFrame, WebSocketConfig},
    },
};

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::str::FromStr;
use std::sync::Arc;

/// CANARI PATCH: the TCP connect the plugin hands every `ws://` / `wss://` URL to.
///
/// Upstream calls `connect_async_tls_with_config`, whose `TcpStream::connect("host:port")` tries
/// the resolved addresses ONE AFTER ANOTHER and waits for each to fail: on a network that hands out
/// IPv6 addresses but carries no IPv6 traffic, the first (IPv6) attempt hangs for the OS connect
/// timeout (20 s measured on Android) before IPv4 is even tried (CALL-WS-V6). The app supplies a
/// Happy Eyeballs connect (RFC 8305) here, and it is MANDATORY: [`Builder::new`] takes it and
/// upstream's `init()` / `Default` are removed, so an app cannot build the plugin without it. The
/// plugin keeps the TLS (when a TLS feature is on) and WebSocket handshakes, for `ws://` and
/// `wss://` alike. Arguments: host as the URL names it (an IPv6 literal without brackets), port.
pub type TcpConnectFn = Arc<
    dyn Fn(String, u16) -> Pin<Box<dyn Future<Output = std::io::Result<TcpStream>> + Send>>
        + Send
        + Sync,
>;

/// CANARI PATCH: the connector [`Builder::new`] was given.
struct TcpConnector(TcpConnectFn);

type Id = u32;
type WebSocket = WebSocketStream<MaybeTlsStream<TcpStream>>;
type WebSocketWriter = SplitSink<WebSocket, Message>;
type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
enum Error {
    #[error(transparent)]
    Websocket(#[from] tokio_tungstenite::tungstenite::Error),
    #[error("connection not found for the given id: {0}")]
    ConnectionNotFound(Id),
    #[error(transparent)]
    InvalidHeaderValue(#[from] tokio_tungstenite::tungstenite::http::header::InvalidHeaderValue),
    #[error(transparent)]
    InvalidHeaderName(#[from] tokio_tungstenite::tungstenite::http::header::InvalidHeaderName),
    /// CANARI PATCH: the TCP connect failed (no address for the host, no route, refused, timed out)
    /// BEFORE any server could answer the handshake. Serialised as `{ kind: "connect", message }`
    /// so the page tells "nobody answered" from "a server answered and refused" by a field, never
    /// by reading a sentence. A handshake refused with an HTTP status stays `Websocket`.
    #[error("{0}")]
    Connect(std::io::Error),
}

impl Serialize for Error {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match self {
            Error::Connect(e) => {
                use serde::ser::SerializeMap;
                let mut map = serializer.serialize_map(Some(2))?;
                map.serialize_entry("kind", "connect")?;
                map.serialize_entry("message", &e.to_string())?;
                map.end()
            }
            _ => serializer.serialize_str(self.to_string().as_str()),
        }
    }
}

#[derive(Default)]
struct ConnectionManager(Mutex<HashMap<Id, WebSocketWriter>>);

/// CANARI PATCH: the connections whose page asked to LEAVE (a close with [`GOING_AWAY`]). Their
/// reader keeps running until the server answers the close, and every frame it forwards goes into
/// the channel of a document that no longer exists: `[TAURI] Couldn't find callback id N` after a
/// reload. A connection in this set forwards nothing more.
#[derive(Default)]
struct LeavingConnections(Mutex<HashSet<Id>>);

/// CANARI PATCH: RFC 6455 close code 1001, "going away" - what a page sends when it is the one
/// going, as opposed to 1000 (an ordinary close the page still listens to).
const GOING_AWAY: u16 = 1001;

/// CANARI PATCH: records `id` as leaving when `message` is the leaving page's close.
async fn mark_leaving(leaving: &LeavingConnections, id: Id, message: &WebSocketMessage) {
    if is_going_away(message) {
        leaving.0.lock().await.insert(id);
    }
}

/// CANARI PATCH: true when `message` is the close a LEAVING page sends, after which nothing it
/// registered can receive a frame.
fn is_going_away(message: &WebSocketMessage) -> bool {
    matches!(message, WebSocketMessage::Close(Some(frame)) if frame.code == GOING_AWAY)
}

#[cfg(any(
    feature = "rustls-tls",
    feature = "rustls-tls-native-roots",
    feature = "native-tls"
))]
struct TlsConnector(Mutex<Option<Connector>>);

#[derive(Deserialize)]
#[serde(untagged, rename_all = "camelCase")]
enum Max {
    None,
    Number(usize),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectionConfig {
    pub read_buffer_size: Option<usize>,
    pub write_buffer_size: Option<usize>,
    pub max_write_buffer_size: Option<usize>,
    pub max_message_size: Option<Max>,
    pub max_frame_size: Option<Max>,
    #[serde(default)]
    pub accept_unmasked_frames: bool,
    pub headers: Option<Vec<(String, String)>>,
}

impl From<ConnectionConfig> for WebSocketConfig {
    fn from(config: ConnectionConfig) -> Self {
        let mut builder =
            WebSocketConfig::default().accept_unmasked_frames(config.accept_unmasked_frames);

        if let Some(read_buffer_size) = config.read_buffer_size {
            builder = builder.read_buffer_size(read_buffer_size)
        }

        if let Some(write_buffer_size) = config.write_buffer_size {
            builder = builder.write_buffer_size(write_buffer_size)
        }

        if let Some(max_write_buffer_size) = config.max_write_buffer_size {
            builder = builder.max_write_buffer_size(max_write_buffer_size)
        }

        if let Some(max_message_size) = config.max_message_size {
            let max_size = match max_message_size {
                Max::None => Option::None,
                Max::Number(n) => Some(n),
            };
            builder = builder.max_message_size(max_size);
        }

        if let Some(max_frame_size) = config.max_frame_size {
            let max_size = match max_frame_size {
                Max::None => Option::None,
                Max::Number(n) => Some(n),
            };
            builder = builder.max_frame_size(max_size);
        }

        builder
    }
}

#[derive(Deserialize, Serialize)]
struct CloseFrame {
    pub code: u16,
    pub reason: String,
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "type", content = "data")]
enum WebSocketMessage {
    Text(String),
    Binary(Vec<u8>),
    Ping(Vec<u8>),
    Pong(Vec<u8>),
    Close(Option<CloseFrame>),
}

#[tauri::command]
async fn connect<R: Runtime>(
    window: Window<R>,
    url: String,
    on_message: Channel<serde_json::Value>,
    config: Option<ConnectionConfig>,
) -> Result<Id> {
    let id = rand::random();
    let mut request = url.into_client_request()?;

    if let Some(headers) = config.as_ref().and_then(|c| c.headers.as_ref()) {
        for (k, v) in headers {
            let header_name = HeaderName::from_str(k.as_str())?;
            let header_value = HeaderValue::from_str(v.as_str())?;
            request.headers_mut().insert(header_name, header_value);
        }
    }

    #[cfg(any(
        feature = "rustls-tls",
        feature = "rustls-tls-native-roots",
        feature = "native-tls"
    ))]
    let tls_connector = match window.try_state::<TlsConnector>() {
        Some(tls_connector) => tls_connector.0.lock().await.clone(),
        None => None,
    };

    // CANARI PATCH: the app's TCP connect, ALWAYS, then the same handshakes upstream runs after
    // its sequential `TcpStream::connect` (`client_async_tls_with_config` for a TLS build,
    // `client_async_with_config` on a plain stream otherwise).
    let tcp_connect = window.state::<TcpConnector>().0.clone();
    let (host, port) = request_host_port(&request)?;
    let stream = tcp_connect(host, port)
        .await
        .map_err(Error::Connect)?;
    #[cfg(any(
        feature = "rustls-tls",
        feature = "rustls-tls-native-roots",
        feature = "native-tls"
    ))]
    let (ws_stream, _) = tokio_tungstenite::client_async_tls_with_config(
        request,
        stream,
        config.map(Into::into),
        tls_connector,
    )
    .await?;
    #[cfg(not(any(
        feature = "rustls-tls",
        feature = "rustls-tls-native-roots",
        feature = "native-tls"
    )))]
    let (ws_stream, _) = tokio_tungstenite::client_async_with_config(
        request,
        MaybeTlsStream::Plain(stream),
        config.map(Into::into),
    )
    .await?;

    // CANARI PATCH: the writer is registered BEFORE `Ok(id)` reaches the page. Upstream inserted
    // it inside the spawned task, so a `send` (a `disconnect()`) issued as soon as the id arrived
    // could find no connection - the close of a socket the page had abandoned did exactly that.
    let (write, read) = ws_stream.split();
    window
        .state::<ConnectionManager>()
        .0
        .lock()
        .await
        .insert(id, write);

    let window_end = window.clone();
    tauri::async_runtime::spawn(async move {
        read.for_each(move |message| {
            let window_ = window.clone();
            let on_message_ = on_message.clone();
            async move {
                if let Ok(Message::Close(_)) = message {
                    let manager = window_.state::<ConnectionManager>();
                    manager.0.lock().await.remove(&id);
                }

                let response = match message {
                    Ok(Message::Text(t)) => {
                        serde_json::to_value(WebSocketMessage::Text(t.to_string())).unwrap()
                    }
                    Ok(Message::Binary(t)) => {
                        serde_json::to_value(WebSocketMessage::Binary(t.to_vec())).unwrap()
                    }
                    Ok(Message::Ping(t)) => {
                        serde_json::to_value(WebSocketMessage::Ping(t.to_vec())).unwrap()
                    }
                    Ok(Message::Pong(t)) => {
                        serde_json::to_value(WebSocketMessage::Pong(t.to_vec())).unwrap()
                    }
                    Ok(Message::Close(t)) => {
                        serde_json::to_value(WebSocketMessage::Close(t.map(|v| CloseFrame {
                            code: v.code.into(),
                            reason: v.reason.to_string(),
                        })))
                        .unwrap()
                    }
                    Ok(Message::Frame(_)) => serde_json::Value::Null, // This value can't be recieved.
                    Err(e) => serde_json::to_value(Error::from(e)).unwrap(),
                };

                // CANARI PATCH: a page that said it is going receives nothing more (see
                // `LeavingConnections`); the writer's removal above already ran for a Close.
                if window_
                    .state::<LeavingConnections>()
                    .0
                    .lock()
                    .await
                    .contains(&id)
                {
                    return;
                }
                let _ = on_message_.send(response);
            }
        })
        .await;
        // The reader ended: nothing is left to mute.
        window_end
            .state::<LeavingConnections>()
            .0
            .lock()
            .await
            .remove(&id);
    });

    Ok(id)
}

/// CANARI PATCH: the host and port `tokio-tungstenite`'s own `connect` derives from a request -
/// the URL's port, else 443 for `wss` and 80 for `ws` - with an IPv6 literal's brackets removed so
/// the result is a name a resolver accepts.
fn request_host_port(
    request: &tokio_tungstenite::tungstenite::handshake::client::Request,
) -> std::result::Result<(String, u16), tokio_tungstenite::tungstenite::Error> {
    use tokio_tungstenite::tungstenite::error::UrlError;
    let uri = request.uri();
    let host = uri
        .host()
        .ok_or(tokio_tungstenite::tungstenite::Error::Url(UrlError::NoHostName))?;
    let host = host
        .strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(host)
        .to_string();
    let port = uri
        .port_u16()
        .or(match uri.scheme_str() {
            Some("wss") => Some(443),
            Some("ws") => Some(80),
            _ => None,
        })
        .ok_or(tokio_tungstenite::tungstenite::Error::Url(
            UrlError::UnsupportedUrlScheme,
        ))?;
    Ok((host, port))
}

#[tauri::command]
async fn send(
    manager: State<'_, ConnectionManager>,
    leaving: State<'_, LeavingConnections>,
    id: Id,
    message: WebSocketMessage,
) -> Result<()> {
    let mut writers = manager.0.lock().await;
    if let Some(write) = writers.get_mut(&id) {
        // CANARI PATCH: marked BEFORE the close is written, so the server's answer cannot beat it,
        // and only for a connection that still HAS a writer: a close on one the server already
        // ended would leave an id nothing ever removes.
        mark_leaving(&leaving, id, &message).await;
        write
            .send(match message {
                WebSocketMessage::Text(t) => Message::Text(t.into()),
                WebSocketMessage::Binary(t) => Message::Binary(t.into()),
                WebSocketMessage::Ping(t) => Message::Ping(t.into()),
                WebSocketMessage::Pong(t) => Message::Pong(t.into()),
                WebSocketMessage::Close(t) => Message::Close(t.map(|v| ProtocolCloseFrame {
                    code: v.code.into(),
                    reason: v.reason.into(),
                })),
            })
            .await?;
        Ok(())
    } else {
        Err(Error::ConnectionNotFound(id))
    }
}

// CANARI PATCH: upstream's `init()` is removed - it built the plugin with no TCP connector.

/// Builder for the WebSocket plugin, used to configure a custom TLS [`Connector`] before calling [`Builder::build`].
// CANARI PATCH: no `Default` - a builder without a TCP connector cannot be made.
pub struct Builder {
    tls_connector: Option<Connector>,
    // CANARI PATCH
    tcp_connector: TcpConnectFn,
}

impl Builder {
    /// CANARI PATCH: creates a [`Builder`] whose every connection, `ws://` and `wss://`, goes
    /// through `tcp_connector` in place of `tokio-tungstenite`'s sequential `TcpStream::connect`
    /// (see [`TcpConnectFn`]); no custom TLS [`Connector`] configured.
    pub fn new(tcp_connector: TcpConnectFn) -> Self {
        Self {
            tls_connector: None,
            tcp_connector,
        }
    }

    /// Sets the TLS [`Connector`] used to establish `wss://` connections.
    ///
    /// When this is not called (or is called with [`Connector::Plain`]) and a `rustls-tls` or
    /// `rustls-tls-native-roots` feature is enabled, [`Builder::build`] installs `rustls`'s `ring`
    /// crypto provider as the process default if none is installed yet.
    pub fn tls_connector(mut self, connector: Connector) -> Self {
        self.tls_connector.replace(connector);
        self
    }

    /// Builds the plugin, registering the `connect` and `send` commands and the shared connection state.
    pub fn build<R: Runtime>(self) -> TauriPlugin<R> {
        PluginBuilder::new("websocket")
            .invoke_handler(tauri::generate_handler![connect, send])
            .setup(|app, _api| {
                #[cfg(any(feature = "rustls-tls", feature = "rustls-tls-native-roots"))]
                if (self.tls_connector.is_none()
                    || matches!(self.tls_connector, Some(Connector::Plain)))
                    && rustls::crypto::CryptoProvider::get_default().is_none()
                {
                    // This can only fail if there is already a default provider which we checked for already.
                    let _ = rustls::crypto::ring::default_provider().install_default();
                }

                app.manage(ConnectionManager::default());
                // CANARI PATCH
                app.manage(LeavingConnections::default());
                // CANARI PATCH
                app.manage(TcpConnector(self.tcp_connector));
                #[cfg(any(
                    feature = "rustls-tls",
                    feature = "rustls-tls-native-roots",
                    feature = "native-tls"
                ))]
                app.manage(TlsConnector(Mutex::new(self.tls_connector)));
                Ok(())
            })
            .build()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// CANARI PATCH: a failed TCP connect reaches the page as a typed object, every other error
    /// stays the plain sentence it always was.
    #[test]
    fn connect_failure_serialises_as_a_typed_object() {
        let err = Error::Connect(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "no address to connect to",
        ));
        let value = serde_json::to_value(&err).unwrap();
        assert_eq!(value["kind"], "connect");
        assert_eq!(value["message"], "no address to connect to");
    }

    /// CANARI PATCH: only a close carrying 1001 mutes a connection; the ordinary `disconnect()` close
    /// (1000), a frame and a bare close do not.
    #[test]
    fn only_a_going_away_close_is_a_leaving_page() {
        let close = |code| {
            WebSocketMessage::Close(Some(CloseFrame {
                code,
                reason: String::new(),
            }))
        };
        assert!(is_going_away(&close(1001)));
        assert!(!is_going_away(&close(1000)));
        assert!(!is_going_away(&WebSocketMessage::Close(None)));
        assert!(!is_going_away(&WebSocketMessage::Text("x".into())));
    }

    /// CANARI PATCH: marking is what `send` does for a connection it holds, and never for another kind
    /// of frame; `send` itself calls it only under a found writer, so an unknown id is never recorded.
    #[test]
    fn marking_records_only_a_going_away_close() {
        let leaving = LeavingConnections::default();
        let close = |code| {
            WebSocketMessage::Close(Some(CloseFrame {
                code,
                reason: String::new(),
            }))
        };
        tauri::async_runtime::block_on(async {
            mark_leaving(&leaving, 1, &close(1000)).await;
            mark_leaving(&leaving, 2, &WebSocketMessage::Text("x".into())).await;
            assert!(leaving.0.lock().await.is_empty());
            mark_leaving(&leaving, 3, &close(1001)).await;
            assert!(leaving.0.lock().await.contains(&3));
        });
    }

    /// CANARI PATCH: a going-away close on a connection that is not held is refused and records nothing.
    #[test]
    fn a_close_on_an_unknown_connection_leaks_no_id() {
        let manager = ConnectionManager::default();
        let leaving = LeavingConnections::default();
        let message = WebSocketMessage::Close(Some(CloseFrame {
            code: 1001,
            reason: String::new(),
        }));
        tauri::async_runtime::block_on(async {
            let mut writers = manager.0.lock().await;
            // The same shape `send` has: nothing is marked unless a writer is found.
            if writers.get_mut(&9).is_some() {
                mark_leaving(&leaving, 9, &message).await;
            }
            assert!(leaving.0.lock().await.is_empty());
        });
    }

    #[test]
    fn other_errors_stay_a_string() {
        let value = serde_json::to_value(Error::ConnectionNotFound(7)).unwrap();
        assert!(value.is_string());
    }
}
