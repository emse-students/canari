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

use std::collections::HashMap;
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
}

impl Serialize for Error {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.to_string().as_str())
    }
}

#[derive(Default)]
struct ConnectionManager(Mutex<HashMap<Id, WebSocketWriter>>);

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
        .map_err(tokio_tungstenite::tungstenite::Error::Io)?;
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

                let _ = on_message_.send(response);
            }
        })
        .await;
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
    id: Id,
    message: WebSocketMessage,
) -> Result<()> {
    if let Some(write) = manager.0.lock().await.get_mut(&id) {
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
