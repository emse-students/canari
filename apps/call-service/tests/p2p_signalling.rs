//! The peer-to-peer signalling relay, driven end to end: the real binary, real WebSockets, real
//! room tokens - the exact frames a browser sends in `CallService.ts`.
//!
//! WHAT IT PROVES. Two users joining a `mode: "p2p"` room are paired with complementary roles, every
//! handshake frame one sends arrives VERBATIM at the other, a third user is refused with a reason,
//! and a party leaving is announced to the one left behind. That is the whole server half of a
//! 1:1 call since 2026-10-17: the media never touches this service.
//!
//! WHAT IT DOES NOT. No browser and no ICE: whether two browsers then connect is the clients' half,
//! taken by hand (docs/wiki/frontend/modules/calls.md). The 25 s keepalive is not waited for here.
//!
//! THE TIMEOUTS ARE LIVENESS GUARDS ONLY: each wait is for a frame, and the bound exists so a hang
//! fails instead of stalling CI. Nothing is asserted on elapsed time.

use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use jsonwebtoken::{encode, EncodingKey, Header};
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

const JWT_SECRET: &str = "test-jwt-secret";
const ROOM_SECRET: &str = "test-room-secret";
const LIVENESS: Duration = Duration::from_secs(20);

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// The service, killed when the test ends whatever its outcome.
struct Service {
    child: Child,
    port: u16,
}

impl Drop for Service {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// The port in the service's "listening on <addr>" line, `None` for any other line.
fn bound_port(line: &str) -> Option<u16> {
    let addr = line.split("Call service listening on ").nth(1)?;
    let digits: String = addr
        .rsplit(':')
        .next()?
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    digits.parse().ok()
}

/// Starts the binary on `PORT=0` and reads the port it BOUND from its own log line.
///
/// THE CHILD BINDS, AND NOTHING ELSE CAN HOLD THAT PORT. The previous shape picked a "free" port
/// here, released it, and let the child bind it later: between the two, a test running in parallel
/// could take it, so a test's readiness probe answered for ANOTHER test's service and its socket
/// was reset under it. The line is logged after `bind` returns, so it is also the readiness event -
/// no probe at all.
async fn start() -> Service {
    let mut child = Command::new(env!("CARGO_BIN_EXE_call-service"))
        .env("PORT", "0")
        .env("RUST_LOG", "info")
        .env("NO_COLOR", "1")
        .env("JWT_SECRET", JWT_SECRET)
        .env("CALL_ROOM_SECRET", ROOM_SECRET)
        .env_remove("CLOUDFLARE_CALLS_API_TOKEN")
        .env_remove("CLOUDFLARE_TURN_KEY_ID")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn call-service");
    let stdout = child.stdout.take().expect("piped stdout");
    // One thread reads the log for the whole run: it hands over the port, then keeps draining so
    // the child never blocks on a full pipe.
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut tx = Some(tx);
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Some(port) = bound_port(&line) {
                if let Some(tx) = tx.take() {
                    let _ = tx.send(port);
                }
            }
        }
    });
    let mut service = Service { child, port: 0 };
    // An event, bounded by LIVENESS: the channel closes without a port if the child exits first.
    service.port = tokio::task::spawn_blocking(move || rx.recv_timeout(LIVENESS))
        .await
        .unwrap()
        .expect("call-service never logged the port it bound");
    service
}

#[test]
fn the_bound_port_is_read_from_the_listening_line_only() {
    assert_eq!(
        bound_port(
            "2026-10-18T00:00:00Z  INFO call_service: Call service listening on 0.0.0.0:41234"
        ),
        Some(41234)
    );
    assert_eq!(
        bound_port("INFO call_service: something else on 0.0.0.0:1"),
        None
    );
}

fn exp() -> usize {
    (std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
        + 300) as usize
}

fn session_token(user: &str) -> String {
    encode(
        &Header::default(),
        &json!({ "sub": user, "exp": exp() }),
        &EncodingKey::from_secret(JWT_SECRET.as_bytes()),
    )
    .unwrap()
}

fn room_token(user: &str, room: &str) -> String {
    room_token_for_group(user, room, "g")
}

fn room_token_for_group(user: &str, room: &str, group: &str) -> String {
    encode(
        &Header::default(),
        &json!({ "sub": user, "room_id": room, "group_id": group, "exp": exp() }),
        &EncodingKey::from_secret(ROOM_SECRET.as_bytes()),
    )
    .unwrap()
}

async fn connect(svc: &Service, user: &str) -> Ws {
    let url = format!(
        "ws://127.0.0.1:{}/ws?token={}",
        svc.port,
        session_token(user)
    );
    connect_async(url).await.expect("ws connect").0
}

async fn send(ws: &mut Ws, frame: Value) {
    ws.send(Message::Text(frame.to_string().into()))
        .await
        .unwrap();
}

/// The next JSON frame, skipping transport frames.
async fn recv(ws: &mut Ws) -> Value {
    timeout(LIVENESS, async {
        loop {
            match ws
                .next()
                .await
                .expect("socket ended")
                .expect("socket error")
            {
                Message::Text(t) => return serde_json::from_str::<Value>(&t).unwrap(),
                _ => continue,
            }
        }
    })
    .await
    .expect("no frame arrived")
}

async fn join(svc: &Service, user: &str, room: &str) -> Ws {
    let mut ws = connect(svc, user).await;
    send(
        &mut ws,
        json!({ "type": "Join", "room_id": room, "room_token": room_token(user, room), "mode": "p2p" }),
    )
    .await;
    ws
}

#[tokio::test]
async fn two_users_are_paired_and_their_handshake_crosses_verbatim() {
    let svc = start().await;
    let room = "room-pair";

    let mut alice = join(&svc, "alice", room).await;
    assert_eq!(
        recv(&mut alice).await,
        json!({ "type": "Joined", "room_id": room })
    );

    let mut bob = join(&svc, "bob", room).await;
    assert_eq!(
        recv(&mut bob).await,
        json!({ "type": "Joined", "room_id": room })
    );
    assert_eq!(
        recv(&mut bob).await,
        json!({ "type": "PeerReady", "initiator": false })
    );
    assert_eq!(
        recv(&mut alice).await,
        json!({ "type": "PeerReady", "initiator": true })
    );

    let offer = json!({ "type": "Offer", "sdp": "{\"type\":\"offer\",\"sdp\":\"v=0 alice\"}" });
    send(&mut alice, offer.clone()).await;
    assert_eq!(recv(&mut bob).await, offer);

    let answer = json!({ "type": "Answer", "sdp": "{\"type\":\"answer\",\"sdp\":\"v=0 bob\"}" });
    send(&mut bob, answer.clone()).await;
    assert_eq!(recv(&mut alice).await, answer);

    let ice = json!({ "type": "IceCandidate", "candidate": "{\"candidate\":\"candidate:1 1 udp 1 192.0.2.1 5000 typ host\"}" });
    send(&mut bob, ice.clone()).await;
    assert_eq!(recv(&mut alice).await, ice);
    send(&mut alice, ice.clone()).await;
    assert_eq!(recv(&mut bob).await, ice);

    // Alice hangs up: Bob is told, and his next frame has nobody to reach.
    alice.close(None).await.unwrap();
    assert_eq!(recv(&mut bob).await, json!({ "type": "PeerLeft" }));
}

#[tokio::test]
async fn a_third_user_is_refused_with_a_reason() {
    let svc = start().await;
    let room = "room-full";

    let mut alice = join(&svc, "alice", room).await;
    recv(&mut alice).await; // Joined
    let mut bob = join(&svc, "bob", room).await;
    recv(&mut bob).await; // Joined
    recv(&mut bob).await; // PeerReady

    let mut carol = join(&svc, "carol", room).await;
    assert_eq!(
        recv(&mut carol).await,
        json!({ "type": "Refused", "reason": "room-full" })
    );
}

#[tokio::test]
async fn a_second_device_replaces_the_first_and_both_ends_are_told() {
    let svc = start().await;
    let room = "room-sibling";

    let mut alice = join(&svc, "alice", room).await;
    recv(&mut alice).await; // Joined
    let mut bob_phone = join(&svc, "bob", room).await;
    recv(&mut bob_phone).await; // Joined
    recv(&mut bob_phone).await; // PeerReady
    assert_eq!(
        recv(&mut alice).await,
        json!({ "type": "PeerReady", "initiator": true })
    );

    let mut bob_pc = join(&svc, "bob", room).await;
    assert_eq!(recv(&mut bob_phone).await, json!({ "type": "PeerLeft" }));
    assert_eq!(
        recv(&mut bob_pc).await,
        json!({ "type": "Joined", "room_id": room })
    );
    assert_eq!(
        recv(&mut bob_pc).await,
        json!({ "type": "PeerReady", "initiator": false })
    );
    // Alice renegotiates from scratch with the new device.
    assert_eq!(
        recv(&mut alice).await,
        json!({ "type": "PeerReady", "initiator": true })
    );
}

/// Knowing the room id is not enough: a VALID token for that id, signed for another conversation,
/// is refused before it is seated - so it is never paired and never receives a candidate - and
/// the real callee still pairs afterwards, the room untouched by the attempt.
#[tokio::test]
async fn a_token_for_another_group_is_refused_and_the_callee_still_pairs() {
    let svc = start().await;
    let room = "room-group";

    let mut alice = join(&svc, "alice", room).await;
    recv(&mut alice).await; // Joined

    let mut mallory = connect(&svc, "mallory").await;
    send(
        &mut mallory,
        json!({ "type": "Join", "room_id": room, "room_token": room_token_for_group("mallory", room, "other"), "mode": "p2p" }),
    )
    .await;
    assert_eq!(
        recv(&mut mallory).await,
        json!({ "type": "Refused", "reason": "group-mismatch" })
    );

    let mut bob = join(&svc, "bob", room).await;
    assert_eq!(
        recv(&mut bob).await,
        json!({ "type": "Joined", "room_id": room })
    );
    assert_eq!(
        recv(&mut bob).await,
        json!({ "type": "PeerReady", "initiator": false })
    );
    // Alice's FIRST frame after her Joined is Bob's pairing: Mallory never produced one.
    assert_eq!(
        recv(&mut alice).await,
        json!({ "type": "PeerReady", "initiator": true })
    );
}

/// A frame above the 64 KiB cap ends that socket instead of being parsed and forwarded.
#[tokio::test]
async fn an_oversized_frame_closes_the_socket() {
    let svc = start().await;
    let mut alice = join(&svc, "alice", "room-big").await;
    recv(&mut alice).await; // Joined

    let sdp = "a".repeat(65 * 1024);
    // The write itself may already fail once the server closes; only the ending is asserted.
    let _ = alice
        .send(Message::Text(
            json!({ "type": "Offer", "sdp": sdp }).to_string().into(),
        ))
        .await;
    let ended = timeout(LIVENESS, async {
        loop {
            match alice.next().await {
                None | Some(Err(_)) | Some(Ok(Message::Close(_))) => return,
                Some(Ok(_)) => continue,
            }
        }
    })
    .await;
    assert!(ended.is_ok(), "an oversized frame must end the socket");
}

#[tokio::test]
async fn a_room_id_belongs_to_one_mode() {
    let svc = start().await;
    let room = "room-mode";

    let mut alice = join(&svc, "alice", room).await;
    recv(&mut alice).await; // Joined (p2p)

    let mut bob = connect(&svc, "bob").await;
    send(
        &mut bob,
        json!({ "type": "Join", "room_id": room, "room_token": room_token("bob", room) }),
    )
    .await;
    assert_eq!(
        recv(&mut bob).await,
        json!({ "type": "Refused", "reason": "mode-mismatch" })
    );
}
