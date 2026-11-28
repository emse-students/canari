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
/// The most sockets open (or opening) at once. The client keeps ONE persistent connection, and a
/// few more only while one is being replaced: anything above this is a page opening in a loop.
/// The relay's per-account cap is the same number (apps/chat-gateway/src/mail_relay.rs).
pub(crate) const MAX_OPEN_SOCKETS: usize = 4;

/// Why a command was refused - a TYPE, which the page reads as `error.kind`.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum MailSocketError {
    /// The connect failed or took longer than its deadline.
    ConnectFailed { detail: String },
    /// No open socket has this id (closed, or never opened).
    UnknownSocket,
    /// [`MAX_OPEN_SOCKETS`] are already open or opening.
    TooManySockets,
    /// The page that asked was replaced while the connect ran; the socket was closed at once.
    Superseded,
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

/// The open sockets, by id, and the opens in flight. Managed by the app (`lib.rs`).
#[derive(Default)]
pub(crate) struct MailSockets {
    next_id: AtomicU64,
    slots: Mutex<Slots>,
}

#[derive(Default)]
struct Slots {
    open: HashMap<u64, mpsc::UnboundedSender<Order>>,
    /// Opens whose connect is running: they hold a place, so the cap cannot be raced.
    connecting: usize,
    /// Moved on by [`MailSockets::close_all`]: an open that began under an older generation
    /// belongs to a page that is gone, and its socket is closed the moment it exists.
    generation: u64,
}

impl MailSockets {
    fn slots(&self) -> std::sync::MutexGuard<'_, Slots> {
        self.slots.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn sender(&self, id: u64) -> Option<mpsc::UnboundedSender<Order>> {
        self.slots().open.get(&id).cloned()
    }

    fn forget(&self, id: u64) {
        self.slots().open.remove(&id);
    }

    /// Takes a place for an open, or refuses past [`MAX_OPEN_SOCKETS`]. Answers the generation the
    /// open began under.
    fn reserve(&self) -> Result<u64, MailSocketError> {
        let mut slots = self.slots();
        if slots.open.len() + slots.connecting >= MAX_OPEN_SOCKETS {
            return Err(MailSocketError::TooManySockets);
        }
        slots.connecting += 1;
        Ok(slots.generation)
    }

    /// Gives back the place of an open that did not produce a socket.
    fn release(&self) {
        let mut slots = self.slots();
        slots.connecting = slots.connecting.saturating_sub(1);
    }

    /// Turns a reserved place into socket `id`, unless the page that asked is gone (a
    /// [`MailSockets::close_all`] ran since `generation`): then nothing is registered.
    fn register(
        &self,
        id: u64,
        generation: u64,
        orders: mpsc::UnboundedSender<Order>,
    ) -> Result<(), MailSocketError> {
        let mut slots = self.slots();
        slots.connecting = slots.connecting.saturating_sub(1);
        if slots.generation != generation {
            return Err(MailSocketError::Superseded);
        }
        slots.open.insert(id, orders);
        Ok(())
    }

    /// Closes every socket and disowns every open in flight; answers how many sockets it closed.
    /// Dropping a socket's sender ends its task as a close (`closed_by_page`).
    fn close_all(&self) -> usize {
        let mut slots = self.slots();
        slots.generation += 1;
        let closed = slots.open.len();
        slots.open.clear();
        closed
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
    let generation = sockets.reserve().inspect_err(|_| {
        log::warn!(
            "[MAIL-SOCKET] open refused: {MAX_OPEN_SOCKETS} sockets already open or opening"
        );
    })?;
    let stream = match tokio::time::timeout(
        CONNECT_DEADLINE,
        crate::happy_eyeballs::connect(MAIL_HOST.to_string(), MAIL_PORT),
    )
    .await
    {
        Ok(Ok(stream)) => stream,
        Ok(Err(e)) => {
            sockets.release();
            log::warn!("[MAIL-SOCKET] connect failed: {e}");
            return Err(MailSocketError::ConnectFailed {
                detail: e.to_string(),
            });
        }
        Err(_) => {
            sockets.release();
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
    if let Err(refusal) = sockets.register(id, generation, orders) {
        // The stream is dropped here: the connection is closed without a byte sent.
        log::debug!("[MAIL-SOCKET] {id}: the page that asked was replaced - closed at once");
        return Err(refusal);
    }
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

/// Closes every socket, and disowns every open in flight. The mail client calls it once per
/// document, before its first open (`tauriSocketTransport.ts`): a reload or a navigation leaves
/// the previous document's sockets with nobody to read them, and the page-load event is not the
/// place for it (it can run after the new document's first native call - `page_ring`).
#[tauri::command]
pub(crate) fn mail_socket_close_all(sockets: State<'_, std::sync::Arc<MailSockets>>) -> usize {
    let count = sockets.close_all();
    log::debug!("[MAIL-SOCKET] a new document: {count} socket(s) of the previous one closed");
    count
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
    fn opens_past_the_cap_are_refused_and_a_failed_connect_gives_its_place_back() {
        let sockets = MailSockets::default();
        for _ in 0..MAX_OPEN_SOCKETS {
            sockets.reserve().unwrap();
        }
        assert_eq!(sockets.reserve(), Err(MailSocketError::TooManySockets));
        sockets.release();
        let generation = sockets.reserve().unwrap();
        // Registered sockets hold their place as well as opening ones.
        let (tx, _rx) = mpsc::unbounded_channel();
        sockets.register(9, generation, tx).unwrap();
        assert_eq!(sockets.reserve(), Err(MailSocketError::TooManySockets));
        sockets.forget(9);
        assert!(sockets.reserve().is_ok());
    }

    #[tokio::test]
    async fn close_all_ends_every_socket_and_disowns_the_opens_in_flight() {
        let sockets = MailSockets::default();
        let (_far, orders, _delivered, task) = start(true);
        let generation = sockets.reserve().unwrap();
        sockets.register(1, generation, orders).unwrap();
        let in_flight = sockets.reserve().unwrap();

        assert_eq!(sockets.close_all(), 1);
        assert_eq!(task.await.unwrap(), MailSocketEnd::ClosedByPage);
        // The open that was connecting belongs to the gone page: refused, and its place freed.
        let (tx, _rx) = mpsc::unbounded_channel();
        assert_eq!(
            sockets.register(2, in_flight, tx),
            Err(MailSocketError::Superseded)
        );
        for _ in 0..MAX_OPEN_SOCKETS {
            sockets.reserve().unwrap();
        }
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
