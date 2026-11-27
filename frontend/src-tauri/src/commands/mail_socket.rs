//! The mail client's native socket (docs/wiki/mail-client.md D4, docs/wiki/mail-client-transport.md).
//!
//! In the apps the page reaches the school mailbox over a TCP socket opened here, instead of the
//! web's relay: no load on our server, and the SAME bytes, because the TLS stays in the page (the
//! `mail-tls` WASM) on every platform. This module is a pipe and nothing more:
//!
//! - ONE destination, a compile-time constant ([`MAIL_HOST`]:[`MAIL_PORT`]). No command takes a host
//!   or a port, so nothing the page sends can point the socket anywhere else;
//! - the connect races IPv6 and IPv4 ([`crate::happy_eyeballs::connect`], the chat socket's rule);
//! - received bytes go to the page as RAW channel messages, never as a JSON array of numbers
//!   (an IPC bridge serialises: durable-rules, "Mobile and native"), and the end as one typed event.
//!
//! Nothing of what crosses is logged: ids, counts and reasons only.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::ipc::{Channel, InvokeBody, InvokeResponseBody, Request};
use tauri::State;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::mpsc;

/// The one host the socket may reach: the school mailbox (RENATER Partage).
pub(crate) const MAIL_HOST: &str = "partage.emse.fr";
/// HTTPS: the only port the design uses (D2), the one Partage's SOAP endpoint answers on.
pub(crate) const MAIL_PORT: u16 = 443;
/// How long the connect may take before the open is refused.
const CONNECT_DEADLINE: Duration = Duration::from_secs(15);
/// Bytes read at a time, and so the largest message the page receives.
const READ_CHUNK: usize = 64 * 1024;
/// The request header naming the socket a raw write is for.
const SOCKET_HEADER: &str = "x-mail-socket";

/// Why a command was refused - a TYPE, which the page reads as `error.kind`.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum MailSocketError {
    /// The connect failed or took longer than its deadline.
    ConnectFailed { detail: String },
    /// No open socket has this id (closed, or never opened).
    UnknownSocket,
    /// A write whose body is not raw bytes, or with no socket id header.
    MalformedWrite,
}

/// How a socket ended - the one event the page receives about it, once.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "reason", rename_all = "snake_case")]
pub(crate) enum MailSocketEnd {
    /// The server closed its side (end of stream).
    PeerClosed,
    /// The page asked for the close.
    ClosedByPage,
    /// Reading failed.
    ReadFailed { detail: String },
    /// Writing failed.
    WriteFailed { detail: String },
}

/// What the page asks of an open socket.
enum Order {
    Write(Vec<u8>),
    Close,
}

/// The open sockets, by id. Managed by the app (`lib.rs`).
#[derive(Default)]
pub(crate) struct MailSockets {
    next_id: AtomicU64,
    open: Mutex<HashMap<u64, mpsc::UnboundedSender<Order>>>,
}

impl MailSockets {
    fn sender(&self, id: u64) -> Option<mpsc::UnboundedSender<Order>> {
        self.open
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(&id)
            .cloned()
    }

    fn forget(&self, id: u64) {
        self.open
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&id);
    }
}

/// Opens the socket to [`MAIL_HOST`]:[`MAIL_PORT`]. Received bytes arrive on `on_data` as raw
/// messages; the end arrives once on `on_end`. Answers the socket's id.
#[tauri::command]
pub(crate) async fn mail_socket_open(
    sockets: State<'_, std::sync::Arc<MailSockets>>,
    on_data: Channel<InvokeResponseBody>,
    on_end: Channel<MailSocketEnd>,
) -> Result<u64, MailSocketError> {
    log::debug!("[MAIL-SOCKET] open {MAIL_HOST}:{MAIL_PORT}");
    let stream = match tokio::time::timeout(
        CONNECT_DEADLINE,
        crate::happy_eyeballs::connect(MAIL_HOST.to_string(), MAIL_PORT),
    )
    .await
    {
        Ok(Ok(stream)) => stream,
        Ok(Err(e)) => {
            log::warn!("[MAIL-SOCKET] connect failed: {e}");
            return Err(MailSocketError::ConnectFailed {
                detail: e.to_string(),
            });
        }
        Err(_) => {
            log::warn!(
                "[MAIL-SOCKET] connect took over {} s",
                CONNECT_DEADLINE.as_secs()
            );
            return Err(MailSocketError::ConnectFailed {
                detail: format!("no connection within {} s", CONNECT_DEADLINE.as_secs()),
            });
        }
    };
    let _ = stream.set_nodelay(true);
    let id = sockets.next_id.fetch_add(1, Ordering::Relaxed);
    let (orders, rx) = mpsc::unbounded_channel();
    sockets
        .open
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(id, orders);
    let registry = sockets.inner().clone();
    tauri::async_runtime::spawn(async move {
        let outcome = run(stream, rx, |bytes| {
            // A page that is gone takes no more bytes: the socket ends as if it had closed it.
            on_data.send(InvokeResponseBody::Raw(bytes)).is_ok()
        })
        .await;
        registry.forget(id);
        log::debug!("[MAIL-SOCKET] {id} ended: {outcome:?}");
        if let Err(e) = on_end.send(outcome) {
            log::debug!("[MAIL-SOCKET] {id}: the page took no end event: {e}");
        }
    });
    log::debug!("[MAIL-SOCKET] {id} open");
    Ok(id)
}

/// Writes the request's RAW body to the socket its `x-mail-socket` header names.
#[tauri::command]
pub(crate) fn mail_socket_write(
    sockets: State<'_, std::sync::Arc<MailSockets>>,
    request: Request<'_>,
) -> Result<(), MailSocketError> {
    let id = request
        .headers()
        .get(SOCKET_HEADER)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        .ok_or(MailSocketError::MalformedWrite)?;
    let InvokeBody::Raw(bytes) = request.body() else {
        log::warn!("[MAIL-SOCKET] {id}: a write whose body is not raw bytes - refused");
        return Err(MailSocketError::MalformedWrite);
    };
    let sender = sockets.sender(id).ok_or(MailSocketError::UnknownSocket)?;
    sender
        .send(Order::Write(bytes.clone()))
        .map_err(|_| MailSocketError::UnknownSocket)
}

/// Closes socket `id`. Its end event (`closed_by_page`) follows on its channel.
#[tauri::command]
pub(crate) fn mail_socket_close(
    sockets: State<'_, std::sync::Arc<MailSockets>>,
    id: u64,
) -> Result<(), MailSocketError> {
    log::debug!("[MAIL-SOCKET] {id}: close asked");
    let sender = sockets.sender(id).ok_or(MailSocketError::UnknownSocket)?;
    sender
        .send(Order::Close)
        .map_err(|_| MailSocketError::UnknownSocket)
}

/// Pipes one socket until it ends: bytes read go to `deliver` (which answers whether the page took
/// them), orders from the page are carried out. Returns how it ended.
async fn run<S, F>(
    stream: S,
    mut orders: mpsc::UnboundedReceiver<Order>,
    deliver: F,
) -> MailSocketEnd
where
    S: AsyncRead + AsyncWrite + Unpin,
    F: Fn(Vec<u8>) -> bool,
{
    let (mut rx, mut tx) = tokio::io::split(stream);
    let mut buf = vec![0u8; READ_CHUNK];
    let end = loop {
        tokio::select! {
            read = rx.read(&mut buf) => match read {
                Ok(0) => break MailSocketEnd::PeerClosed,
                Ok(n) => {
                    if !deliver(buf[..n].to_vec()) {
                        break MailSocketEnd::ClosedByPage;
                    }
                }
                Err(e) => break MailSocketEnd::ReadFailed { detail: e.to_string() },
            },
            order = orders.recv() => match order {
                Some(Order::Write(bytes)) => {
                    if let Err(e) = tx.write_all(&bytes).await {
                        break MailSocketEnd::WriteFailed { detail: e.to_string() };
                    }
                }
                // Every sender gone is the registry forgetting the socket: a close.
                Some(Order::Close) | None => break MailSocketEnd::ClosedByPage,
            },
        }
    };
    let _ = tx.shutdown().await;
    end
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use tokio::io::duplex;

    /// Runs a socket over an in-memory pipe; returns the far end, the order sender, what was
    /// delivered and the task's end.
    fn start(
        page_takes: bool,
    ) -> (
        tokio::io::DuplexStream,
        mpsc::UnboundedSender<Order>,
        Arc<Mutex<Vec<u8>>>,
        tokio::task::JoinHandle<MailSocketEnd>,
    ) {
        let (near, far) = duplex(1024);
        let (orders, rx) = mpsc::unbounded_channel();
        let delivered = Arc::new(Mutex::new(Vec::new()));
        let sink = delivered.clone();
        let task = tokio::spawn(async move {
            run(near, rx, move |bytes| {
                sink.lock().unwrap().extend(bytes);
                page_takes
            })
            .await
        });
        (far, orders, delivered, task)
    }

    #[tokio::test]
    async fn bytes_cross_both_ways_and_the_peer_closing_ends_it() {
        let (mut far, orders, delivered, task) = start(true);
        orders.send(Order::Write(b"ClientHello".to_vec())).unwrap();
        let mut got = [0u8; 11];
        far.read_exact(&mut got).await.unwrap();
        assert_eq!(&got, b"ClientHello");
        far.write_all(b"ServerHello").await.unwrap();
        drop(far);
        assert_eq!(task.await.unwrap(), MailSocketEnd::PeerClosed);
        assert_eq!(delivered.lock().unwrap().as_slice(), b"ServerHello");
    }

    #[tokio::test]
    async fn a_close_from_the_page_ends_it_and_shuts_the_write_side() {
        let (mut far, orders, _delivered, task) = start(true);
        orders.send(Order::Close).unwrap();
        assert_eq!(task.await.unwrap(), MailSocketEnd::ClosedByPage);
        let mut rest = Vec::new();
        far.read_to_end(&mut rest).await.unwrap();
        assert!(rest.is_empty(), "the far end sees an end of stream");
    }

    #[tokio::test]
    async fn a_page_that_takes_nothing_more_ends_it() {
        let (mut far, _orders, _delivered, task) = start(false);
        far.write_all(b"late").await.unwrap();
        assert_eq!(task.await.unwrap(), MailSocketEnd::ClosedByPage);
    }

    #[tokio::test]
    async fn the_registry_forgetting_the_socket_is_a_close() {
        let (_far, orders, _delivered, task) = start(true);
        drop(orders);
        assert_eq!(task.await.unwrap(), MailSocketEnd::ClosedByPage);
    }

    #[test]
    fn the_destination_is_the_one_mailbox() {
        assert_eq!((MAIL_HOST, MAIL_PORT), ("partage.emse.fr", 443));
    }

    #[test]
    fn the_end_and_the_errors_reach_the_page_as_tagged_types() {
        assert_eq!(
            serde_json::to_value(MailSocketEnd::PeerClosed).unwrap(),
            serde_json::json!({ "reason": "peer_closed" })
        );
        assert_eq!(
            serde_json::to_value(MailSocketEnd::ReadFailed { detail: "x".into() }).unwrap(),
            serde_json::json!({ "reason": "read_failed", "detail": "x" })
        );
        assert_eq!(
            serde_json::to_value(MailSocketError::UnknownSocket).unwrap(),
            serde_json::json!({ "kind": "unknown_socket" })
        );
        assert_eq!(
            serde_json::to_value(MailSocketError::ConnectFailed { detail: "d".into() }).unwrap(),
            serde_json::json!({ "kind": "connect_failed", "detail": "d" })
        );
    }
}
