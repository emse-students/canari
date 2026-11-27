//! The client against an in-process rustls server, bytes moved by hand: what a transport does.

use super::*;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use rustls::{ServerConfig, ServerConnection};

/// A server certificate made for the test, naming `names`, self-signed (it is its own root).
struct TestServer {
    cert: CertificateDer<'static>,
    key: Vec<u8>,
}

impl TestServer {
    fn naming(names: &[&str]) -> Self {
        let made = rcgen::generate_simple_self_signed(
            names.iter().map(|n| n.to_string()).collect::<Vec<_>>(),
        )
        .expect("a self-signed certificate is made");
        TestServer {
            cert: made.cert.der().clone(),
            key: made.signing_key.serialize_der(),
        }
    }

    fn connection(&self) -> ServerConnection {
        let config = ServerConfig::builder_with_provider(provider())
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_no_client_auth()
            .with_single_cert(
                vec![self.cert.clone()],
                PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(self.key.clone())),
            )
            .unwrap();
        let mut conn = ServerConnection::new(Arc::new(config)).unwrap();
        // The test server answers large bodies in one write.
        conn.set_buffer_limit(None);
        conn
    }

    /// A root store holding this server's certificate and nothing else.
    fn as_root(&self) -> RootCertStore {
        let mut roots = RootCertStore::empty();
        roots.add(self.cert.clone()).unwrap();
        roots
    }
}

/// Moves bytes both ways until neither side has anything to send. Returns the client's first
/// error, as a transport would surface it.
fn pump(client: &mut MailTls, server: &mut ServerConnection) -> Result<(), MailTlsError> {
    for _ in 0..32 {
        let to_server = client.take_ciphertext();
        if !to_server.is_empty() {
            server.read_tls(&mut to_server.as_slice()).unwrap();
            // A server-side refusal (the client's alert) is the client's error to report.
            let _ = server.process_new_packets();
        }
        let mut to_client = Vec::new();
        while server.wants_write() {
            server.write_tls(&mut to_client).unwrap();
        }
        if !to_client.is_empty() {
            client.feed_ciphertext(&to_client)?;
        }
        if to_server.is_empty() && to_client.is_empty() {
            return Ok(());
        }
    }
    panic!("the two sides never went quiet");
}

#[test]
fn a_session_starts_with_a_client_hello_waiting() {
    let mut client = MailTls::new().unwrap();
    assert!(client.is_handshaking());
    let hello = client.take_ciphertext();
    // A TLS record: content type 22 (handshake), then the ClientHello (type 1).
    assert_eq!(hello[0], 22, "a handshake record");
    assert_eq!(hello[5], 1, "a ClientHello");
    // And it names the one server: its SNI is in the clear in the hello.
    let sni = SERVER_NAME.as_bytes();
    assert!(
        hello.windows(sni.len()).any(|w| w == sni),
        "the SNI names {SERVER_NAME}"
    );
}

#[test]
fn a_handshake_with_a_trusted_server_completes_and_carries_plaintext_both_ways() {
    let server_identity = TestServer::naming(&[SERVER_NAME]);
    let mut server = server_identity.connection();
    let mut client = MailTls::with_roots(server_identity.as_root()).unwrap();

    // Written before the handshake ends: buffered, then sent under the keys.
    client
        .write_plaintext(b"POST /service/soap HTTP/1.1\r\n")
        .unwrap();
    pump(&mut client, &mut server).unwrap();
    assert!(!client.is_handshaking(), "the handshake completed");

    let mut received = Vec::new();
    server.reader().read_to_end(&mut received).ok();
    assert_eq!(received, b"POST /service/soap HTTP/1.1\r\n");

    server.writer().write_all(b"HTTP/1.1 200 OK\r\n").unwrap();
    pump(&mut client, &mut server).unwrap();
    assert_eq!(client.read_plaintext(), b"HTTP/1.1 200 OK\r\n");
    // Read once: nothing is handed twice.
    assert!(client.read_plaintext().is_empty());
}

#[test]
fn a_server_whose_root_is_not_trusted_is_refused_as_a_certificate_error() {
    // The real client trusts the Mozilla roots only; a self-signed server is not one of them.
    let server_identity = TestServer::naming(&[SERVER_NAME]);
    let mut server = server_identity.connection();
    let mut client = MailTls::new().unwrap();
    let err = pump(&mut client, &mut server).unwrap_err();
    assert_eq!(err.kind, MailTlsErrorKind::Certificate, "{err}");
}

#[test]
fn another_root_than_the_servers_is_refused() {
    let server_identity = TestServer::naming(&[SERVER_NAME]);
    let other = TestServer::naming(&[SERVER_NAME]);
    let mut server = server_identity.connection();
    let mut client = MailTls::with_roots(other.as_root()).unwrap();
    let err = pump(&mut client, &mut server).unwrap_err();
    assert_eq!(err.kind, MailTlsErrorKind::Certificate, "{err}");
}

#[test]
fn a_trusted_certificate_for_another_name_is_refused() {
    // Trusted, but made for another host: the name is a constant the certificate must carry.
    let server_identity = TestServer::naming(&["other.example"]);
    let mut server = server_identity.connection();
    let mut client = MailTls::with_roots(server_identity.as_root()).unwrap();
    let err = pump(&mut client, &mut server).unwrap_err();
    assert_eq!(err.kind, MailTlsErrorKind::Certificate, "{err}");
}

#[test]
fn bytes_that_are_not_tls_are_a_protocol_error() {
    let mut client = MailTls::new().unwrap();
    client.take_ciphertext();
    let err = client
        .feed_ciphertext(b"HTTP/1.1 400 Bad Request\r\n\r\n")
        .unwrap_err();
    assert_eq!(err.kind, MailTlsErrorKind::Protocol, "{err}");
}

#[test]
fn a_close_notify_from_the_server_is_seen_and_a_write_after_our_close_is_refused() {
    let server_identity = TestServer::naming(&[SERVER_NAME]);
    let mut server = server_identity.connection();
    let mut client = MailTls::with_roots(server_identity.as_root()).unwrap();
    pump(&mut client, &mut server).unwrap();
    assert!(!client.peer_closed());

    server.send_close_notify();
    pump(&mut client, &mut server).unwrap();
    assert!(client.peer_closed());

    client.close();
    assert!(
        !client.take_ciphertext().is_empty(),
        "our close_notify is owed"
    );
    let err = client.write_plaintext(b"late").unwrap_err();
    assert_eq!(err.kind, MailTlsErrorKind::Closed);
}

#[test]
fn every_kind_has_a_distinct_stable_code() {
    let kinds = [
        MailTlsErrorKind::Certificate,
        MailTlsErrorKind::PeerAlert,
        MailTlsErrorKind::Protocol,
        MailTlsErrorKind::Incompatible,
        MailTlsErrorKind::Closed,
    ];
    let codes: std::collections::HashSet<&str> = kinds.iter().map(|k| k.code()).collect();
    assert_eq!(codes.len(), kinds.len());
    // The TypeScript side names these codes (frontend/src/lib/mail/tlsConnection.ts).
    for code in [
        "certificate",
        "peer_alert",
        "protocol",
        "incompatible",
        "closed",
    ] {
        assert!(codes.contains(code), "{code}");
    }
}

/// A connected client and its server.
fn connected() -> (MailTls, ServerConnection) {
    let server_identity = TestServer::naming(&[SERVER_NAME]);
    let mut server = server_identity.connection();
    let mut client = MailTls::with_roots(server_identity.as_root()).unwrap();
    pump(&mut client, &mut server).unwrap();
    assert!(!client.is_handshaking());
    (client, server)
}

/// `len` bytes of a recognisable pattern.
fn body(len: usize) -> Vec<u8> {
    (0..len).map(|i| (i % 251) as u8).collect()
}

/// Everything the server owes the client, as one byte string.
fn server_output(server: &mut ServerConnection) -> Vec<u8> {
    let mut out = Vec::new();
    while server.wants_write() {
        server.write_tls(&mut out).unwrap();
    }
    out
}

#[test]
fn a_200_kib_answer_fed_in_64_kib_chunks_is_read_whole() {
    // rustls keeps at most 16 KiB of unread plaintext: a feed that did not drain it failed with
    // "received plaintext buffer full" on any answer over ~36 KiB.
    let (mut client, mut server) = connected();
    let sent = body(200 * 1024);
    server.writer().write_all(&sent).unwrap();
    let wire = server_output(&mut server);
    for chunk in wire.chunks(64 * 1024) {
        client.feed_ciphertext(chunk).unwrap();
    }
    assert_eq!(client.read_plaintext(), sent);
}

#[test]
fn a_200_kib_answer_fed_at_once_is_read_whole() {
    let (mut client, mut server) = connected();
    let sent = body(200 * 1024);
    server.writer().write_all(&sent).unwrap();
    let wire = server_output(&mut server);
    client.feed_ciphertext(&wire).unwrap();
    assert_eq!(client.read_plaintext(), sent);
}

#[test]
fn a_1_mib_write_is_taken_and_arrives_whole() {
    // rustls caps its send queue at 64 KiB by default; an attachment over it failed as `closed`.
    let (mut client, mut server) = connected();
    let sent = body(1024 * 1024);
    client.write_plaintext(&sent).unwrap();
    let wire = client.take_ciphertext();
    let mut slice = wire.as_slice();
    let mut received = Vec::new();
    while !slice.is_empty() {
        server.read_tls(&mut slice).unwrap();
        server.process_new_packets().unwrap();
        let mut part = Vec::new();
        let _ = server.reader().read_to_end(&mut part);
        received.extend_from_slice(&part);
    }
    assert_eq!(received, sent);
}

#[test]
fn rustls_failures_are_classified_once_at_the_boundary() {
    let missing: MailTlsError = rustls::Error::NoCertificatesPresented.into();
    assert_eq!(missing.kind, MailTlsErrorKind::Certificate);
    let incompatible: MailTlsError =
        rustls::Error::PeerIncompatible(rustls::PeerIncompatible::NoCipherSuitesInCommon).into();
    assert_eq!(incompatible.kind, MailTlsErrorKind::Incompatible);
    let decrypt: MailTlsError = rustls::Error::DecryptError.into();
    assert_eq!(decrypt.kind, MailTlsErrorKind::Protocol);
}

#[test]
fn the_close_notify_is_seen_after_the_plaintext_before_it() {
    let (mut client, mut server) = connected();
    server.writer().write_all(b"last").unwrap();
    server.send_close_notify();
    let wire = server_output(&mut server);
    client.feed_ciphertext(&wire).unwrap();
    assert!(client.peer_closed());
    assert_eq!(client.read_plaintext(), b"last");
}
