//! The peer-to-peer signalling relay, driven end to end: the real binary, real WebSockets, real
//! room tokens - the exact frames a browser sends in `CallService.ts`.
//!
//! WHAT IT PROVES. Two users joining a `mode: "p2p"` room are paired with complementary roles, every
//! handshake frame one sends arrives VERBATIM at the other, a third user is refused with a reason,
//! and a party leaving is announced to the one left behind. That is the whole server half of a
//! 1:1 call since 2026-10-17: the media never touches this service.
//!
//! WHAT IT DOES NOT. No browser and no ICE: whether two browsers then connect is the clients' half,
//! taken by hand (docs/wiki/frontend/modules/calls.md). The default 10 s keepalive is not waited
//! for here; the keepalive tests shorten it with `CALL_KEEPALIVE_MS` and keep every socket that must
//! stay alive POLLED (a socket answers a Ping only while it is read - see `drained`).
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
/// The keepalive of the half-open tests: short enough that detection (<= 3 periods) is quick, long
/// enough that a loaded CI runner never leaves a POLLED socket a full period without its Pong.
const TEST_KEEPALIVE_MS: u64 = 1000;

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
    start_with_grace(None).await
}

/// [`start`], with `CALL_P2P_SEAT_GRACE_SEC` set when `grace_secs` is given. A grace of 0 makes the
/// expiry of an away seat an EVENT that follows its `PeerAway` at once - no wait in any test.
async fn start_with_grace(grace_secs: Option<u64>) -> Service {
    start_with(grace_secs, None).await
}

/// [`start_with_grace`], plus `CALL_KEEPALIVE_MS` when `keepalive_ms` is given: a short period
/// makes a silent peer's detection an event that follows within a few ticks.
async fn start_with(grace_secs: Option<u64>, keepalive_ms: Option<u64>) -> Service {
    let mut command = Command::new(env!("CARGO_BIN_EXE_call-service"));
    match grace_secs {
        Some(secs) => command.env("CALL_P2P_SEAT_GRACE_SEC", secs.to_string()),
        None => command.env_remove("CALL_P2P_SEAT_GRACE_SEC"),
    };
    match keepalive_ms {
        Some(ms) => command.env("CALL_KEEPALIVE_MS", ms.to_string()),
        None => command.env_remove("CALL_KEEPALIVE_MS"),
    };
    let mut child = command
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

/// Reads the `Joined` frame of `room` and returns the resume token it carries for this seat.
async fn joined(ws: &mut Ws, room: &str) -> String {
    let frame = recv(ws).await;
    assert_eq!(frame["type"], "Joined", "{frame}");
    assert_eq!(frame["room_id"], room, "{frame}");
    frame["resume_token"]
        .as_str()
        .expect("a p2p Joined carries a resume token")
        .to_string()
}

/// Opens a new socket for `user` and joins `room` with a token as given (a resume token here).
async fn join_with(svc: &Service, user: &str, room: &str, token: &str) -> Ws {
    let mut ws = connect(svc, user).await;
    send(
        &mut ws,
        json!({ "type": "Join", "room_id": room, "room_token": token, "mode": "p2p" }),
    )
    .await;
    ws
}

/// Two users paired in `room`; returns both sockets and the resume token of each.
async fn paired(svc: &Service, room: &str) -> (Ws, String, Ws, String) {
    let mut alice = join(svc, "alice", room).await;
    let alice_resume = joined(&mut alice, room).await;
    let mut bob = join(svc, "bob", room).await;
    let bob_resume = joined(&mut bob, room).await;
    assert_eq!(
        recv(&mut bob).await,
        json!({ "type": "PeerReady", "initiator": false })
    );
    assert_eq!(
        recv(&mut alice).await,
        json!({ "type": "PeerReady", "initiator": true })
    );
    (alice, alice_resume, bob, bob_resume)
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
    joined(&mut alice, room).await;

    let mut bob = join(&svc, "bob", room).await;
    joined(&mut bob, room).await;
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
    joined(&mut bob_pc, room).await;
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
    joined(&mut bob, room).await;
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

/// The MESSAGE cap, apart from the frame cap: 65 KiB sent as five 13 KiB fragments, every frame
/// well under 64 KiB. Only `max_message_size` can refuse it - without it the reassembled message
/// would be parsed and relayed.
#[tokio::test]
async fn an_oversized_message_in_small_frames_closes_the_socket() {
    use tokio_tungstenite::tungstenite::protocol::frame::coding::{Data, OpCode};
    use tokio_tungstenite::tungstenite::protocol::frame::Frame;

    let svc = start().await;
    let mut alice = join(&svc, "alice", "room-fragments").await;
    recv(&mut alice).await; // Joined

    let fragment = vec![b'a'; 13 * 1024];
    for i in 0..5 {
        let opcode = if i == 0 {
            OpCode::Data(Data::Text)
        } else {
            OpCode::Data(Data::Continue)
        };
        // A write may already fail once the server has closed; only the ending is asserted.
        let _ = alice
            .send(Message::Frame(Frame::message(
                fragment.clone(),
                opcode,
                i == 4,
            )))
            .await;
    }
    let ended = timeout(LIVENESS, async {
        loop {
            match alice.next().await {
                None | Some(Err(_)) | Some(Ok(Message::Close(_))) => return,
                Some(Ok(_)) => continue,
            }
        }
    })
    .await;
    assert!(
        ended.is_ok(),
        "a message over the cap must end the socket, whatever its frame sizes"
    );
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

/// CALL-WIFI (2026-10-19): a socket that dies WITHOUT a Close frame - a phone losing Wi-Fi - does
/// not end the call. The partner is told `PeerAway`, the same device takes its seat back with its
/// resume token, both are told `PeerReady { resumed: true }` with UNCHANGED roles, and the
/// handshake crosses again.
#[tokio::test]
async fn a_lost_socket_is_resumed_in_place_and_the_call_goes_on() {
    let svc = start().await;
    let room = "room-blip";
    let (mut alice, _, bob, bob_resume) = paired(&svc, room).await;

    // No Close frame: the TCP connection just goes, as when the radio does.
    drop(bob);
    assert_eq!(recv(&mut alice).await, json!({ "type": "PeerAway" }));

    let mut bob = join_with(&svc, "bob", room, &bob_resume).await;
    let fresh = joined(&mut bob, room).await;
    assert_ne!(
        fresh, bob_resume,
        "every Joined carries a fresh resume token"
    );
    assert_eq!(
        recv(&mut bob).await,
        json!({ "type": "PeerReady", "initiator": false, "resumed": true })
    );
    assert_eq!(
        recv(&mut alice).await,
        json!({ "type": "PeerReady", "initiator": true, "resumed": true })
    );

    // The ICE restart offer crosses as any offer does.
    let offer = json!({ "type": "Offer", "sdp": "{\"type\":\"offer\",\"sdp\":\"v=0 restart\"}" });
    send(&mut alice, offer.clone()).await;
    assert_eq!(recv(&mut bob).await, offer);
}

/// A Close frame is a hangup, not a blip: the partner is told `PeerLeft` at once, and the resume
/// token of the seat that hung up opens nothing afterwards.
#[tokio::test]
async fn a_close_frame_frees_the_seat_and_its_resume_is_refused() {
    let svc = start().await;
    let room = "room-hangup";
    let (alice, alice_resume, mut bob, _) = paired(&svc, room).await;

    let mut alice = alice;
    alice.close(None).await.unwrap();
    assert_eq!(recv(&mut bob).await, json!({ "type": "PeerLeft" }));

    let mut again = join_with(&svc, "alice", room, &alice_resume).await;
    assert_eq!(
        recv(&mut again).await,
        json!({ "type": "Refused", "reason": "call-over" })
    );
}

/// The grace ran out (0 s here, so the expiry follows at once): the partner is told the call is
/// over, and the late resume is refused.
#[tokio::test]
async fn an_away_seat_that_is_not_resumed_ends_the_call() {
    let svc = start_with_grace(Some(0)).await;
    let room = "room-expired";
    let (mut alice, _, bob, bob_resume) = paired(&svc, room).await;

    drop(bob);
    assert_eq!(recv(&mut alice).await, json!({ "type": "PeerAway" }));
    assert_eq!(recv(&mut alice).await, json!({ "type": "PeerLeft" }));

    let mut late = join_with(&svc, "bob", room, &bob_resume).await;
    assert_eq!(
        recv(&mut late).await,
        json!({ "type": "Refused", "reason": "call-over" })
    );
}

/// A resume token is bound to its holder: presented by another user's session it is refused
/// before anything is seated, and the away seat is still there for its owner.
#[tokio::test]
async fn a_resume_token_is_refused_to_another_user() {
    let svc = start().await;
    let room = "room-stolen";
    let (mut alice, _, bob, bob_resume) = paired(&svc, room).await;
    drop(bob);
    assert_eq!(recv(&mut alice).await, json!({ "type": "PeerAway" }));

    let mut mallory = join_with(&svc, "mallory", room, &bob_resume).await;
    assert_eq!(
        recv(&mut mallory).await,
        json!({ "type": "Refused", "reason": "token-refused" })
    );

    let mut bob = join_with(&svc, "bob", room, &bob_resume).await;
    joined(&mut bob, room).await;
    assert_eq!(
        recv(&mut bob).await,
        json!({ "type": "PeerReady", "initiator": false, "resumed": true })
    );
}

/// The polite side cannot restart ICE itself, so it ASKS: the request crosses verbatim to the
/// initiator, which is the one that offers.
#[tokio::test]
async fn an_ice_restart_request_reaches_the_initiator() {
    let svc = start().await;
    let room = "room-restart-ask";
    let (mut alice, _, mut bob, _) = paired(&svc, room).await;

    send(&mut bob, json!({ "type": "IceRestartRequest" })).await;
    assert_eq!(
        recv(&mut alice).await,
        json!({ "type": "IceRestartRequest" })
    );
}

/// A resume can arrive before the server saw the old socket die. The old socket is then CLOSED,
/// not left half-open for the keepalive to find, and its closing tells the partner nothing.
#[tokio::test]
async fn a_resume_over_a_live_socket_closes_the_old_one() {
    let svc = start().await;
    let room = "room-live-resume";
    let (mut alice, _, mut bob_old, bob_resume) = paired(&svc, room).await;

    let mut bob = join_with(&svc, "bob", room, &bob_resume).await;
    joined(&mut bob, room).await;
    assert_eq!(
        recv(&mut bob).await,
        json!({ "type": "PeerReady", "initiator": false, "resumed": true })
    );
    assert_eq!(
        recv(&mut alice).await,
        json!({ "type": "PeerReady", "initiator": true, "resumed": true })
    );

    let closed = timeout(LIVENESS, async {
        loop {
            match bob_old.next().await {
                None | Some(Err(_)) | Some(Ok(Message::Close(_))) => return,
                Some(Ok(Message::Text(t))) => panic!("the replaced socket got a frame: {t}"),
                Some(Ok(_)) => continue,
            }
        }
    })
    .await;
    assert!(closed.is_ok(), "the replaced socket must be closed");

    // Alice's next frame is Bob's, from his NEW socket: the old one's end was not announced.
    let offer = json!({ "type": "Offer", "sdp": "{\"type\":\"offer\",\"sdp\":\"v=0 again\"}" });
    send(&mut bob, offer.clone()).await;
    assert_eq!(recv(&mut alice).await, offer);
}

/// Reads `ws` on a task of its own for as long as it lives, forwarding each JSON frame. A socket is
/// answered (Pong) only while it is READ, so a party that must stay alive under a short keepalive
/// is never left unpolled while the test drives the other one - no window of time decides a test.
fn drained(mut ws: Ws) -> tokio::sync::mpsc::UnboundedReceiver<Value> {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    tokio::spawn(async move {
        while let Some(Ok(msg)) = ws.next().await {
            if let Message::Text(t) = msg {
                if tx.send(serde_json::from_str::<Value>(&t).unwrap()).is_err() {
                    return;
                }
            }
        }
    });
    rx
}

/// The next frame a drained socket forwarded.
async fn next(rx: &mut tokio::sync::mpsc::UnboundedReceiver<Value>) -> Value {
    timeout(LIVENESS, rx.recv())
        .await
        .expect("no frame arrived")
        .expect("socket ended")
}

/// Alice joins and is drained AT ONCE, then Bob joins and reads his pairing; Bob's socket is then
/// left unread - a half-open socket's shape - while Alice keeps answering every Ping.
async fn paired_with_a_silent_bob(
    svc: &Service,
    room: &str,
) -> (tokio::sync::mpsc::UnboundedReceiver<Value>, Ws, String) {
    let mut alice = join(svc, "alice", room).await;
    joined(&mut alice, room).await;
    let mut alice = drained(alice);
    let mut bob = join(svc, "bob", room).await;
    let bob_resume = joined(&mut bob, room).await;
    assert_eq!(
        recv(&mut bob).await,
        json!({ "type": "PeerReady", "initiator": false })
    );
    assert_eq!(
        next(&mut alice).await,
        json!({ "type": "PeerReady", "initiator": true })
    );
    (alice, bob, bob_resume)
}

/// The bench's 14 s and 90 s failures (2026-10-19): a phone losing Wi-Fi leaves a HALF-OPEN socket
/// that never errors, so the seat was never marked away and the partner never learnt anything. Now
/// a peer that answers no keepalive ping is held dead: the partner gets `PeerAway`, and - grace 0
/// here - `PeerLeft` right after, so a ghost call ends on the partner too.
#[tokio::test]
async fn a_silent_half_open_peer_is_held_dead_and_the_partner_is_told() {
    let svc = start_with(Some(0), Some(TEST_KEEPALIVE_MS)).await;
    let room = "room-half-open";
    let (mut alice, _bob_silent, _) = paired_with_a_silent_bob(&svc, room).await;

    assert_eq!(next(&mut alice).await, json!({ "type": "PeerAway" }));
    assert_eq!(next(&mut alice).await, json!({ "type": "PeerLeft" }));
}

/// The same silent peer, with a grace: it comes back on a new socket and resumes its seat. Alice is
/// polled throughout, so she is never the one held dead while Bob rejoins.
#[tokio::test]
async fn a_peer_held_dead_by_the_keepalive_can_still_resume() {
    let svc = start_with(None, Some(TEST_KEEPALIVE_MS)).await;
    let room = "room-half-open-resume";
    let (mut alice, _bob_silent, bob_resume) = paired_with_a_silent_bob(&svc, room).await;
    assert_eq!(next(&mut alice).await, json!({ "type": "PeerAway" }));

    let mut bob = join_with(&svc, "bob", room, &bob_resume).await;
    joined(&mut bob, room).await;
    assert_eq!(
        recv(&mut bob).await,
        json!({ "type": "PeerReady", "initiator": false, "resumed": true })
    );
    assert_eq!(
        next(&mut alice).await,
        json!({ "type": "PeerReady", "initiator": true, "resumed": true })
    );
}
