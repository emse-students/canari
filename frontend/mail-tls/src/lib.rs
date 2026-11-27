//! A sans-IO TLS client for exactly ONE server: the school mailbox, `partage.emse.fr`
//! (docs/wiki/mail-client.md D3, docs/wiki/mail-client-transport.md).
//!
//! The device speaks TLS to Partage itself, so no Canari server ever holds a byte of mail in the
//! clear (principle 1): on the web the bytes cross a blind relay in `chat-gateway`, in the apps a
//! native TCP socket. Both carry the SAME ciphertext, produced here. This crate does no I/O at all:
//!
//! - the transport hands it what arrived ([`MailTls::feed_ciphertext`]) and sends what it owes
//!   ([`MailTls::take_ciphertext`]);
//! - the HTTP layer above writes requests ([`MailTls::write_plaintext`]) and reads answers
//!   ([`MailTls::read_plaintext`]).
//!
//! The server name is a constant and the roots are the Mozilla store (`webpki-roots`): nothing a
//! caller passes can point the client at another host or make it trust another certificate.
//!
//! Errors are TYPED where they are made ([`MailTlsErrorKind`]), so the layer above classifies a
//! failure by its kind and never by its message.

use std::io::{self, Read, Write};
use std::sync::Arc;

use rustls::client::ClientConnection;
use rustls::crypto::CryptoProvider;
use rustls::pki_types::ServerName;
use rustls::{ClientConfig, RootCertStore};

#[cfg(target_arch = "wasm32")]
mod wasm;

/// The one server this client speaks to. Not a parameter: the relay and the native socket dial
/// the same single host, and the certificate must name it.
pub const SERVER_NAME: &str = "partage.emse.fr";

/// What kind of failure ended a TLS session - the discriminator the transport reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MailTlsErrorKind {
    /// The server's certificate did not verify: an unknown root, an expired or not-yet-valid
    /// certificate, or one that does not name [`SERVER_NAME`]. Never retried blindly: it is either
    /// an interception or a change at Partage that someone must read.
    Certificate,
    /// The server ended the session with a TLS alert of its own.
    PeerAlert,
    /// The bytes received are not TLS this client can follow (malformed, or unexpected).
    Protocol,
    /// The server offers nothing this client accepts (no TLS 1.3, no shared cipher, group or
    /// signature scheme): a change at Partage, not a fault of the bytes.
    Incompatible,
    /// Plaintext was written after the session was closed.
    Closed,
}

impl MailTlsErrorKind {
    /// The stable code of the kind, the one string that crosses into JavaScript as `error.kind`.
    pub fn code(self) -> &'static str {
        match self {
            MailTlsErrorKind::Certificate => "certificate",
            MailTlsErrorKind::PeerAlert => "peer_alert",
            MailTlsErrorKind::Protocol => "protocol",
            MailTlsErrorKind::Incompatible => "incompatible",
            MailTlsErrorKind::Closed => "closed",
        }
    }
}

/// A TLS failure: its [`MailTlsErrorKind`], and a detail for the log (never branched on).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MailTlsError {
    pub kind: MailTlsErrorKind,
    pub detail: String,
}

impl std::fmt::Display for MailTlsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "TLS {}: {}", self.kind.code(), self.detail)
    }
}

impl std::error::Error for MailTlsError {}

impl From<rustls::Error> for MailTlsError {
    /// Classifies rustls's error at the boundary, once.
    fn from(e: rustls::Error) -> Self {
        let kind = match &e {
            // A server that presents no certificate is judged like one whose certificate fails.
            rustls::Error::InvalidCertificate(_) | rustls::Error::NoCertificatesPresented => {
                MailTlsErrorKind::Certificate
            }
            rustls::Error::AlertReceived(_) => MailTlsErrorKind::PeerAlert,
            rustls::Error::PeerIncompatible(_) => MailTlsErrorKind::Incompatible,
            _ => MailTlsErrorKind::Protocol,
        };
        MailTlsError {
            kind,
            detail: e.to_string(),
        }
    }
}

/// The crypto provider: ring, the one rustls ships that builds for both wasm32-unknown-unknown and
/// native (mail-client-transport.md#the-crypto-provider).
fn provider() -> Arc<CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

/// The Mozilla root store, as `webpki-roots` ships it.
fn mozilla_roots() -> RootCertStore {
    RootCertStore {
        roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
    }
}

/// The client configuration trusting `roots`.
///
/// The clock is rustls's own `UnixTime::now()`: `SystemTime` natively, `Date.now()` on wasm32
/// through rustls-pki-types' `web` feature (Cargo.toml).
fn config(roots: RootCertStore) -> Result<Arc<ClientConfig>, MailTlsError> {
    let config = ClientConfig::builder_with_provider(provider())
        .with_safe_default_protocol_versions()?
        .with_root_certificates(roots)
        .with_no_client_auth();
    Ok(Arc::new(config))
}

/// One TLS session to [`SERVER_NAME`], driven by its caller (sans-IO).
pub struct MailTls {
    conn: ClientConnection,
    /// Plaintext decrypted and not yet handed out. rustls keeps at most 16 KiB of unread plaintext
    /// and refuses more ciphertext past it, so every feed drains it here, as it decrypts: a feed of
    /// any size is taken whole, and the caller reads at its own pace.
    plaintext: Vec<u8>,
    /// The server sent its close_notify: everything it meant to send has arrived. The ONLY proof
    /// that a body framed by the end of the connection is complete (an ended socket is not one).
    peer_closed: bool,
    /// Set by [`MailTls::close`]. rustls itself accepts plaintext after its close_notify (and
    /// sends it nowhere useful), so the refusal is this crate's own.
    closed: bool,
}

impl MailTls {
    /// A new session to [`SERVER_NAME`] trusting the Mozilla roots. Its first ClientHello is
    /// already waiting in [`MailTls::take_ciphertext`].
    pub fn new() -> Result<Self, MailTlsError> {
        Self::with_roots(mozilla_roots())
    }

    /// The same, trusting `roots` only - for the tests, which make their own server certificate.
    pub(crate) fn with_roots(roots: RootCertStore) -> Result<Self, MailTlsError> {
        let name = ServerName::try_from(SERVER_NAME).map_err(|e| MailTlsError {
            kind: MailTlsErrorKind::Protocol,
            detail: format!("server name: {e}"),
        })?;
        let mut conn = ClientConnection::new(config(roots)?, name)?;
        // No cap on what is queued to send: the caller drains it with `take_ciphertext` after every
        // write, so the queue never outgrows one request - and a capped queue would refuse an
        // attachment larger than the cap with an error that says nothing about why.
        conn.set_buffer_limit(None);
        Ok(MailTls {
            conn,
            plaintext: Vec::new(),
            peer_closed: false,
            closed: false,
        })
    }

    /// Hands the session bytes that arrived from the server, of any length, and processes them.
    /// An error ends the session: its alert, if any, is waiting in [`MailTls::take_ciphertext`].
    pub fn feed_ciphertext(&mut self, mut bytes: &[u8]) -> Result<(), MailTlsError> {
        while !bytes.is_empty() {
            // `read_tls` takes at most what its buffer accepts, so it is called until all is taken;
            // the plaintext of each pass is drained before the next, or rustls would refuse it.
            let taken = self.conn.read_tls(&mut bytes).map_err(|e| MailTlsError {
                kind: MailTlsErrorKind::Protocol,
                detail: format!("read_tls: {e}"),
            })?;
            let state = self.conn.process_new_packets()?;
            if state.peer_has_closed() {
                self.peer_closed = true;
            }
            self.drain_plaintext()?;
            if taken == 0 {
                break;
            }
        }
        Ok(())
    }

    /// Moves everything rustls decrypted into [`MailTls::plaintext`].
    fn drain_plaintext(&mut self) -> Result<(), MailTlsError> {
        let mut chunk = [0u8; 16 * 1024];
        loop {
            match self.conn.reader().read(&mut chunk) {
                // 0: the close_notify was received and everything before it was read.
                Ok(0) => return Ok(()),
                Ok(n) => self.plaintext.extend_from_slice(&chunk[..n]),
                // Nothing more decrypted for now.
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => return Ok(()),
                // Not swallowed: rustls says the stream ended in a way it cannot vouch for
                // (`UnexpectedEof`, the bytes ended without a close_notify), and the caller hears it
                // as a typed error rather than as an ordinary end.
                Err(e) => {
                    return Err(MailTlsError {
                        kind: MailTlsErrorKind::Protocol,
                        detail: format!("reading plaintext: {:?}", e.kind()),
                    })
                }
            }
        }
    }

    /// The bytes the session owes the server (handshake, records, alerts), empty when none.
    pub fn take_ciphertext(&mut self) -> Vec<u8> {
        let mut out = Vec::new();
        while self.conn.wants_write() {
            // Writing into a Vec cannot fail.
            if self.conn.write_tls(&mut out).unwrap_or(0) == 0 {
                break;
            }
        }
        out
    }

    /// Queues `data`, of any length, to be encrypted and sent. Before the handshake ends it is
    /// buffered and sent as soon as the keys exist.
    pub fn write_plaintext(&mut self, data: &[u8]) -> Result<(), MailTlsError> {
        if self.closed {
            return Err(MailTlsError {
                kind: MailTlsErrorKind::Closed,
                detail: format!("{} bytes written after close", data.len()),
            });
        }
        // With no buffer limit (`with_roots`) rustls takes every byte; a failure here is not a
        // closed session, so it is not called one.
        self.conn
            .writer()
            .write_all(data)
            .map_err(|e| MailTlsError {
                kind: MailTlsErrorKind::Protocol,
                detail: format!("queueing {} bytes: {:?}", data.len(), e.kind()),
            })
    }

    /// The plaintext received so far and not yet read, empty when none.
    pub fn read_plaintext(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.plaintext)
    }

    /// Whether the handshake is still running.
    pub fn is_handshaking(&self) -> bool {
        self.conn.is_handshaking()
    }

    /// Whether the server sent its close_notify: no more plaintext will come, and what came is
    /// whole.
    pub fn peer_closed(&self) -> bool {
        self.peer_closed
    }

    /// Ends the session politely: the close_notify is waiting in [`MailTls::take_ciphertext`].
    pub fn close(&mut self) {
        self.closed = true;
        self.conn.send_close_notify();
    }
}

#[cfg(test)]
mod tests;
