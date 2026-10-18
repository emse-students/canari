use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::get,
    Router,
};
use dashmap::mapref::one::Ref;
use dashmap::DashMap;
use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};
use tracing::{error, info, warn};
use uuid::Uuid;
use webrtc::api::media_engine::MediaEngine;
use webrtc::api::setting_engine::SettingEngine;
use webrtc::api::APIBuilder;
use webrtc::ice::mdns::MulticastDnsMode;
use webrtc::ice_transport::ice_candidate::RTCIceCandidateInit;
use webrtc::ice_transport::ice_connection_state::RTCIceConnectionState;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::interceptor::registry::Registry;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::policy::ice_transport_policy::RTCIceTransportPolicy;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::rtcp::payload_feedbacks::full_intra_request::FullIntraRequest;
use webrtc::rtcp::payload_feedbacks::picture_loss_indication::PictureLossIndication;
use webrtc::rtp_transceiver::rtp_codec::RTPCodecType;
use webrtc::rtp_transceiver::rtp_sender::RTCRtpSender;
use webrtc::track::track_local::track_local_static_rtp::TrackLocalStaticRTP;
use webrtc::track::track_local::{TrackLocal, TrackLocalWriter};
use webrtc::track::track_remote::TrackRemote;

mod p2p;

use p2p::{count_relayed, JoinOutcome, P2pPeer, P2pRoom, RelayedKind};

type RoomId = String;
type PeerId = String;

/// How a room carries a call, chosen by the client in `Join` and fixed when the room is created.
///
/// `Sfu` is the original design: this service terminates every peer connection and forwards the
/// media. `P2p` (2026-10-17, the 1:1 revival) opens no peer connection here at all and only relays
/// the two browsers' handshake to each other - see [`p2p`]. An absent field reads as `Sfu`, so a
/// client that predates the field keeps the behaviour it was built against.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
enum RoomMode {
    #[default]
    Sfu,
    P2p,
}

impl RoomMode {
    fn as_str(self) -> &'static str {
        match self {
            RoomMode::Sfu => "sfu",
            RoomMode::P2p => "p2p",
        }
    }
}

/// How often the socket loop pings an idle client. The host nginx in front of production closes a
/// proxied socket after 60 s without a read from upstream (no `proxy_read_timeout` is set there,
/// realtime-media-feasibility section 9, 4a), and a peer-to-peer call sends NO signalling once ICE
/// has connected - so without this, every 1:1 call would lose its socket a minute in.
const KEEPALIVE: std::time::Duration = std::time::Duration::from_secs(25);

/// The largest signalling frame accepted. The biggest legitimate one is an SDP offer, a few KiB
/// for audio and well under 16 KiB with video; the library default (64 MiB) would let one socket
/// make the server buffer, parse and - in peer-to-peer mode - forward a frame of that size.
const MAX_SIGNAL_MESSAGE_BYTES: usize = 64 * 1024;

/// JWT payload (`sub` = user id).
#[derive(Serialize, Deserialize)]
struct Claims {
    sub: String,
    exp: usize,
}

/// Payload for short-lived room access tokens (issued by chat-delivery-service).
#[derive(Serialize, Deserialize)]
struct RoomClaims {
    /// ID of the room the token grants access to.
    room_id: String,
    /// User ID of the token holder.
    sub: String,
    /// The conversation the room was opened in. chat-delivery-service binds the room to it at
    /// `initiate` and signs only that value, so a peer-to-peer room seats two holders of the SAME
    /// group and nobody else (see [`p2p::P2pRoom::join`]).
    group_id: String,
    exp: usize,
}

/// Query parameters for the WebSocket upgrade endpoint.
///
/// `token`: JWT access token fallback for Tauri Android/mobile, where the WebView
/// cookie is not sent on cross-origin WebSocket upgrades. Used only when the
/// `canari_ws_token` cookie is absent (same pattern as chat-gateway).
#[derive(Deserialize)]
struct AuthParams {
    token: Option<String>,
}

struct AppState {
    rooms: DashMap<RoomId, Arc<Room>>,
    /// Peer-to-peer rooms. Separate from `rooms` because they hold no peer connection, and so are
    /// never reaped on a clock: each one is removed by the socket loop of its last peer, the
    /// moment that socket ends, so its lifetime is exactly the lifetime of its sockets.
    p2p_rooms: DashMap<RoomId, Arc<P2pRoom>>,
    jwt_secret: String,
    /// Secret shared with chat-delivery-service to sign and verify room access tokens.
    call_room_secret: String,
}

struct Room {
    tracks: Mutex<Vec<PublishedTrack>>,
    peers: DashMap<PeerId, PeerContext>,
    /// Per-peer generation counter to debounce renegotiation (audio + video = one offer).
    renegotiate_gen: DashMap<PeerId, u64>,
    /// Last signal activity timestamp - used to evict stale rooms.
    last_activity: std::sync::Mutex<std::time::Instant>,
}

struct PeerContext {
    pc: Arc<RTCPeerConnection>,
    notify_tx: mpsc::Sender<SignalMessage>,
    /// Trickle ICE from the browser may arrive before the Offer is applied.
    pending_ice_candidates: Mutex<Vec<RTCIceCandidateInit>>,
    /// The server's record of this peer's call. Shared with the socket loop, which outlives
    /// the entry in `Room.peers` and is what finally emits it.
    ledger: Arc<CallLedger>,
}

/// The per-socket state `handle_signal` may set: which room this peer joined, and the ledger
/// recording it. Both live on the socket loop's stack rather than only in the room, because
/// the loop must still be able to close the record after the peer has been removed from the
/// room - which is exactly what happens when another device evicts it.
struct PeerSession {
    room_id: Option<RoomId>,
    ledger: Option<Arc<CallLedger>>,
    /// The mode of the room joined; meaningful only once `room_id` is set.
    mode: RoomMode,
}

/// Why a peer's SFU session ended.
///
/// These tokens are read by the cross-client campaign, so they are a contract and must not
/// drift - see `docs/wiki/services/call-service.md`. The distinctions are the point: before
/// this existed, a user hanging up and a socket dying mid-call left the SAME empty log, and no
/// client's own log can tell them apart either.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Disposition {
    /// The client sent a WebSocket Close frame: a deliberate hangup.
    ClientClose,
    /// The socket failed without a Close frame - the network went away mid-call.
    TransportError,
    /// The stream ended with neither a Close frame nor an error (a hard-killed client).
    StreamEnded,
    /// The peer exceeded the signal rate limit and we disconnected it.
    RateLimited,
    /// We could not write to the socket: the client is no longer reading.
    SendFailed,
    /// Another device of the same user joined this room and replaced this peer.
    SiblingEvicted,
    /// The room was reclaimed after 30 min of signal silence with this peer still in it.
    RoomReaped,
}

impl Disposition {
    /// Stable grep token. Changing one invalidates every campaign row that read it.
    fn as_str(self) -> &'static str {
        match self {
            Disposition::ClientClose => "client-close",
            Disposition::TransportError => "transport-error",
            Disposition::StreamEnded => "stream-ended",
            Disposition::RateLimited => "rate-limited",
            Disposition::SendFailed => "send-failed",
            Disposition::SiblingEvicted => "sibling-evicted",
            Disposition::RoomReaped => "room-reaped",
        }
    }

    /// True when the design intends this ending. Everything else is a defect until shown
    /// otherwise, so the summary is emitted at a level that accuses: a record nobody's eye is
    /// drawn to is a record read a day late.
    fn is_expected(self) -> bool {
        matches!(self, Disposition::ClientClose | Disposition::SiblingEvicted)
    }
}

/// Increments a ledger counter. `Relaxed` is correct: nothing branches on these, and they are
/// read once at session end, after every callback that touched them is gone.
fn bump(counter: &AtomicU32) {
    counter.fetch_add(1, Ordering::Relaxed);
}

fn count(counter: &AtomicU32) -> u32 {
    counter.load(Ordering::Relaxed)
}

/// The server's record of one peer's time in a room, from `Join` to the socket closing.
///
/// A call failure is seen half by each client, and neither half is evidence: the caller says
/// "it never rang", the callee says "I answered and nothing happened", and no client log can
/// say which frame failed to arrive. This is the third witness, and the only one that sees
/// both sides. It counts what crossed the SFU in each direction so ONE line separates causes
/// indistinguishable from either end - a client that never offered, an offer whose answer
/// could not be sent back, ICE gathered on one side only, and a session that connected from
/// one that merely lasted.
///
/// The counters are atomics because the ICE, track and RTCP callbacks each run on their own
/// task; the three `Mutex` fields are written at most a handful of times per session.
struct CallLedger {
    /// The room, which is also the `callId` used by chat-delivery-service's ring fan-out - the
    /// two services' logs join on this value and on nothing else.
    room_id: RoomId,
    peer_id: PeerId,
    /// Which design carried this session. In `P2p` the server never sees ICE, so the record
    /// reports `paired_ms` (when the other party arrived) instead of `connected_ms` - printing an
    /// ICE figure this service cannot measure would be a column answering a question it was not
    /// written for.
    mode: RoomMode,
    /// When `Join` was accepted.
    joined: std::time::Instant,
    /// SFU: first moment ICE reported a usable pair. P2P: first moment the room held both
    /// parties. `None` means media never flowed (SFU) or nobody ever came (P2P).
    connected: std::sync::Mutex<Option<std::time::Instant>>,
    /// Last ICE connection state seen, so the record says how negotiation ended.
    ice_state: std::sync::Mutex<Option<String>>,
    /// Set once - see [`CallLedger::end`].
    disposition: std::sync::Mutex<Option<Disposition>>,
    /// Offers received from this client. The client always offers first, so `offer_in=0` on a
    /// session that lasted is a client that joined and then never negotiated.
    offers_in: AtomicU32,
    /// Answers handed back, counted when the frame reaches the socket writer.
    answers_out: AtomicU32,
    /// Renegotiation offers pushed to this client after someone else published a track.
    offers_out: AtomicU32,
    /// Answers to those renegotiation offers. `offer_out > answer_in` is a client that stopped
    /// answering - a failure neither client can see from its own side.
    answers_in: AtomicU32,
    /// Trickle candidates received from this client.
    ice_in: AtomicU32,
    /// Of those, the ones held back because the SDP had not been applied yet.
    ice_in_buffered: AtomicU32,
    /// Of those, the ones the ICE agent refused, plus any dropped to the buffer cap.
    ice_in_failed: AtomicU32,
    /// Candidates the SFU gathered and handed to this client.
    ice_out: AtomicU32,
    /// Of those, the ones that never reached the socket writer.
    ice_out_failed: AtomicU32,
    /// Tracks this peer published into the room.
    tracks_published: AtomicU32,
    /// Tracks of other peers this peer was subscribed to.
    tracks_subscribed: AtomicU32,
}

impl CallLedger {
    fn new(room_id: RoomId, peer_id: PeerId, mode: RoomMode) -> Self {
        Self {
            room_id,
            peer_id,
            mode,
            joined: std::time::Instant::now(),
            connected: std::sync::Mutex::new(None),
            ice_state: std::sync::Mutex::new(None),
            disposition: std::sync::Mutex::new(None),
            offers_in: AtomicU32::new(0),
            answers_out: AtomicU32::new(0),
            offers_out: AtomicU32::new(0),
            answers_in: AtomicU32::new(0),
            ice_in: AtomicU32::new(0),
            ice_in_buffered: AtomicU32::new(0),
            ice_in_failed: AtomicU32::new(0),
            ice_out: AtomicU32::new(0),
            ice_out_failed: AtomicU32::new(0),
            tracks_published: AtomicU32::new(0),
            tracks_subscribed: AtomicU32::new(0),
        }
    }

    /// Records the first ICE connection and returns how long it took - ONCE. Later calls
    /// return `None`, so a connection that flaps and recovers cannot re-log a first connect.
    fn mark_connected(&self) -> Option<std::time::Duration> {
        let mut guard = self.connected.lock().ok()?;
        if guard.is_some() {
            return None;
        }
        let now = std::time::Instant::now();
        *guard = Some(now);
        Some(now.duration_since(self.joined))
    }

    fn set_ice_state(&self, state: &str) {
        if let Ok(mut guard) = self.ice_state.lock() {
            *guard = Some(state.to_string());
        }
    }

    /// Records why the session ended, keeping the FIRST cause. An evicted peer still sends a
    /// Close frame a moment later, and a reaped room's socket still errors out afterwards;
    /// recording the last event would report the consequence and hide the cause. Returns
    /// whether this call is the one that set it.
    fn end(&self, disposition: Disposition) -> bool {
        match self.disposition.lock() {
            Ok(mut guard) if guard.is_none() => {
                *guard = Some(disposition);
                true
            }
            _ => false,
        }
    }

    fn disposition(&self) -> Option<Disposition> {
        self.disposition.lock().ok().and_then(|g| *g)
    }

    /// How long the peer held the room, in milliseconds.
    fn session_ms(&self) -> u128 {
        self.joined.elapsed().as_millis()
    }

    /// Milliseconds since ICE connected, or `None` when it never did. Read together with
    /// `session_ms`, this is the pair that separates "the call was short" from "the call never
    /// happened" - a session can last a minute with nothing here, and only these two figures
    /// side by side say which one the user actually saw.
    fn connected_ms(&self) -> Option<u128> {
        self.connected
            .lock()
            .ok()
            .and_then(|g| *g)
            .map(|at| at.elapsed().as_millis())
    }

    /// The ICE counts alone, for the line emitted when negotiation reaches a terminal state -
    /// which is where they answer a question. Candidates gathered on both sides with no pair
    /// formed is a TURN fault; `ice_in=0` is a client that never trickled; and those two are
    /// indistinguishable from either client's own log.
    fn ice_counters(&self) -> String {
        format!(
            "ice_in={} ice_buffered={} ice_in_failed={} ice_out={} ice_out_failed={}",
            count(&self.ice_in),
            count(&self.ice_in_buffered),
            count(&self.ice_in_failed),
            count(&self.ice_out),
            count(&self.ice_out_failed),
        )
    }

    /// Every counter, with no clock in it, so a test can pin it exactly.
    fn counters(&self) -> String {
        format!(
            "offer_in={} answer_out={} offer_out={} answer_in={} {} tracks_pub={} tracks_sub={}",
            count(&self.offers_in),
            count(&self.answers_out),
            count(&self.offers_out),
            count(&self.answers_in),
            self.ice_counters(),
            count(&self.tracks_published),
            count(&self.tracks_subscribed),
        )
    }

    /// The one line the campaign greps for. `connected_ms=-` is not a missing value: it is the
    /// statement that media never flowed, and it is the field to read first.
    fn summary(&self) -> String {
        if self.mode == RoomMode::P2p {
            // `paired_ms=-` is the statement that the other party never arrived. Whether media
            // then flowed is the clients' to say: ICE ran between them, not through here.
            return format!(
                "[call] session end room={} peer={} mode=p2p disposition={} duration_ms={} paired_ms={} {}",
                self.room_id,
                self.peer_id,
                self.disposition().map(Disposition::as_str).unwrap_or("unknown"),
                self.session_ms(),
                self.connected_ms()
                    .map(|ms| ms.to_string())
                    .unwrap_or_else(|| "-".to_string()),
                self.counters(),
            );
        }
        format!(
            "[call] session end room={} peer={} disposition={} duration_ms={} connected_ms={} ice_state={} {}",
            self.room_id,
            self.peer_id,
            self.disposition().map(Disposition::as_str).unwrap_or("unknown"),
            self.session_ms(),
            self.connected_ms()
                .map(|ms| ms.to_string())
                .unwrap_or_else(|| "-".to_string()),
            self.ice_state
                .lock()
                .ok()
                .and_then(|g| g.clone())
                .unwrap_or_else(|| "none".to_string()),
            self.counters(),
        )
    }

    /// Emits the record at a level matching what it says. An unexpected ending accuses, and an
    /// unclassified one (`disposition=unknown`) is a hole in this file, not in the call.
    fn emit(&self) {
        if self
            .disposition()
            .map(Disposition::is_expected)
            .unwrap_or(false)
        {
            info!("{}", self.summary());
        } else {
            warn!("{}", self.summary());
        }
    }
}

/// A track being forwarded by the SFU, kept with a handle to its publisher so we can
/// request keyframes on demand (the SFU forwards opaque E2E-encrypted RTP and cannot
/// detect when a keyframe is needed).
struct PublishedTrack {
    local: Arc<TrackLocalStaticRTP>,
    /// Publisher's PeerConnection (Weak to avoid a reference cycle with its callbacks).
    publisher_pc: std::sync::Weak<RTCPeerConnection>,
    /// SSRC of the publisher's remote track, used as the PLI media ssrc.
    media_ssrc: u32,
    is_video: bool,
    /// Last time a keyframe (PLI) was requested for this track. Shared by the on-demand
    /// forwarders and the periodic recovery net so they coalesce instead of both nudging.
    last_pli: Arc<std::sync::Mutex<std::time::Instant>>,
}

/// Records that a keyframe was just requested, so the periodic recovery net can stay
/// quiet while on-demand PLIs are already flowing.
fn mark_pli_sent(last_pli: &Arc<std::sync::Mutex<std::time::Instant>>) {
    if let Ok(mut ts) = last_pli.lock() {
        *ts = std::time::Instant::now();
    }
}

/// Asks a publisher for a video keyframe a few times over ~1.5 s. Needed when a new
/// subscriber attaches to an already-running video track (it joined after the last
/// keyframe and would otherwise only get undecodable delta frames). No-op once the
/// publisher's PeerConnection is gone.
fn request_keyframe_burst(
    publisher_pc: std::sync::Weak<RTCPeerConnection>,
    media_ssrc: u32,
    last_pli: Arc<std::sync::Mutex<std::time::Instant>>,
) {
    tokio::spawn(async move {
        for delay_ms in [0u64, 300, 800, 1500] {
            if delay_ms > 0 {
                tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
            }
            match publisher_pc.upgrade() {
                Some(pc) => {
                    let _ = pc
                        .write_rtcp(&[Box::new(PictureLossIndication {
                            sender_ssrc: 0,
                            media_ssrc,
                        })])
                        .await;
                    mark_pli_sent(&last_pli);
                }
                None => break,
            }
        }
    });
}

/// Forwards a subscriber's keyframe requests (PLI/FIR) to the track's publisher.
/// On-demand keyframe generation: when a subscriber's decoder needs an IDR (packet
/// loss, late join), its browser sends RTCP feedback on the SFU's sender; we relay a
/// PLI to the publisher so it emits a keyframe only when actually needed - far cheaper
/// than blindly forcing keyframes on a timer (which wastes relay bandwidth and degrades
/// quality). The SFU can't read the encrypted media, but RTCP feedback is unencrypted.
fn forward_pli_from_subscriber(
    sender: Arc<RTCRtpSender>,
    publisher_pc: std::sync::Weak<RTCPeerConnection>,
    media_ssrc: u32,
    last_pli: Arc<std::sync::Mutex<std::time::Instant>>,
) {
    tokio::spawn(async move {
        while let Ok((packets, _)) = sender.read_rtcp().await {
            let wants_keyframe = packets.iter().any(|p| {
                let any = p.as_any();
                any.downcast_ref::<PictureLossIndication>().is_some()
                    || any.downcast_ref::<FullIntraRequest>().is_some()
            });
            if !wants_keyframe {
                continue;
            }
            match publisher_pc.upgrade() {
                Some(pc) => {
                    info!(
                        "[keyframe] relaying subscriber PLI to publisher ssrc={}",
                        media_ssrc
                    );
                    let _ = pc
                        .write_rtcp(&[Box::new(PictureLossIndication {
                            sender_ssrc: 0,
                            media_ssrc,
                        })])
                        .await;
                    mark_pli_sent(&last_pli);
                }
                None => break,
            }
        }
        info!("[keyframe] PLI forward loop ended for ssrc={}", media_ssrc);
    });
}

/// Slow recovery net: nudges one video keyframe from the publisher every few seconds.
/// On-demand PLI forwarding (forward_pli_from_subscriber) is the primary mechanism, but a
/// relayed PLI can itself be dropped on the lossy TURN path - leaving a subscriber frozen
/// on its last decodable frame indefinitely (the classic "video freezes after ~2 s" on a
/// constrained mobile uplink). A low-frequency timer bounds any freeze to a few seconds
/// without the bandwidth cost or starvation of a fast periodic PLI. Spawned once per
/// published video track; stops when the publisher's PeerConnection is gone.
fn periodic_keyframe_recovery(
    publisher_pc: std::sync::Weak<RTCPeerConnection>,
    media_ssrc: u32,
    last_pli: Arc<std::sync::Mutex<std::time::Instant>>,
) {
    tokio::spawn(async move {
        let period = std::time::Duration::from_secs(3);
        let mut interval = tokio::time::interval(period);
        // First tick fires immediately; skip it (the initial keyframe burst already covers t=0).
        interval.tick().await;
        loop {
            interval.tick().await;
            // Skip when an on-demand PLI (subscriber request / new-subscriber burst) was
            // relayed within the last period: it already refreshed the keyframe, so nudging
            // again would just waste relay bandwidth. Only fire when the channel went quiet.
            let recent = last_pli
                .lock()
                .map(|ts| ts.elapsed() < period)
                .unwrap_or(false);
            if recent {
                continue;
            }
            match publisher_pc.upgrade() {
                Some(pc) => {
                    let _ = pc
                        .write_rtcp(&[Box::new(PictureLossIndication {
                            sender_ssrc: 0,
                            media_ssrc,
                        })])
                        .await;
                    mark_pli_sent(&last_pli);
                }
                None => break,
            }
        }
    });
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(tag = "type")]
enum SignalMessage {
    /// Client must supply a `room_token` issued by chat-delivery-service to prove group membership.
    Join {
        room_id: String,
        room_token: Option<String>,
        /// `"p2p"` for a peer-to-peer room; absent means `"sfu"` (see [`RoomMode`]).
        #[serde(default)]
        mode: RoomMode,
    },
    /// Sent when the peer is registered and ready to receive Offer/Answer signaling.
    Joined {
        room_id: String,
    },
    /// P2P only, server -> client: the room now holds both parties. `initiator` makes the offer
    /// and is the impolite side; the other answers and yields on a collision. Sent again to the
    /// remaining peer when the other party's device is replaced, so it renegotiates from scratch.
    PeerReady {
        initiator: bool,
    },
    /// P2P only, server -> client: the other party's socket is gone (or this device was replaced
    /// by another of the same user). The call this socket was signalling is over.
    PeerLeft,
    /// P2P only, server -> client: the `Join` was refused, and why, so the client fails at once
    /// with a reason instead of waiting out its Join timeout.
    Refused {
        reason: String,
    },
    Offer {
        sdp: String,
    },
    Answer {
        sdp: String,
    },
    IceCandidate {
        candidate: String,
    },
}

impl SignalMessage {
    /// Frame name for logs. The payloads are whole SDP blobs and candidate strings, neither of
    /// which any log line should carry - what a reader needs is which frame it was.
    fn kind(&self) -> &'static str {
        match self {
            SignalMessage::Join { .. } => "join",
            SignalMessage::Joined { .. } => "joined",
            SignalMessage::Offer { .. } => "offer",
            SignalMessage::Answer { .. } => "answer",
            SignalMessage::IceCandidate { .. } => "ice",
            SignalMessage::PeerReady { .. } => "peer-ready",
            SignalMessage::PeerLeft => "peer-left",
            SignalMessage::Refused { .. } => "refused",
        }
    }
}

/// Resolves the room a signal belongs to and refreshes that room's activity clock. Both misses
/// are named: a frame arriving before `Join` completed, or for a room that no longer exists, is
/// dropped - and a dropped frame with no line is exactly the half of a failure neither client
/// can see.
fn resolve_room(
    state: &Arc<AppState>,
    session: &PeerSession,
    peer_id: &str,
    frame: &str,
) -> Option<(RoomId, Arc<Room>)> {
    let Some(room_id) = session.room_id.clone() else {
        warn!(
            "[call] {} sent {} before Join completed - dropped",
            peer_id, frame
        );
        return None;
    };
    let Some(room) = state.rooms.get(&room_id).map(|r| r.value().clone()) else {
        warn!(
            "[call] {} sent {} for room {}, which no longer exists - dropped",
            peer_id, frame, room_id
        );
        return None;
    };
    if let Ok(mut ts) = room.last_activity.lock() {
        *ts = std::time::Instant::now();
    }
    Some((room_id, room))
}

/// Resolves this peer's own context inside its room. A signal for a peer the room no longer
/// holds is dropped; the drop is loud when nothing has yet said why the peer is gone, and quiet
/// when something has - an evicted device goes on trickling ICE for several seconds, and
/// repeating a cause the log already carries is noise rather than evidence.
fn resolve_peer<'a>(
    room: &'a Arc<Room>,
    session: &PeerSession,
    peer_id: &str,
    room_id: &str,
    frame: &str,
) -> Option<Ref<'a, PeerId, PeerContext>> {
    if let Some(ctx) = room.peers.get(peer_id) {
        return Some(ctx);
    }
    let already_explained = session
        .ledger
        .as_ref()
        .map(|l| l.disposition().is_some())
        .unwrap_or(false);
    if !already_explained {
        warn!(
            "[call] {} sent {} in room {} but is not registered in it - dropped",
            peer_id, frame, room_id
        );
    }
    None
}

/// Records why a session ended on its ledger, when it has one. A socket that never completed a
/// `Join` has no ledger and no call to account for.
fn end_session(session: &PeerSession, disposition: Disposition) {
    if let Some(ledger) = &session.ledger {
        ledger.end(disposition);
    }
}

/// Validates the room-token secret read from `CALL_ROOM_SECRET`.
///
/// WHY AN ERROR AND NOT A WARNING: the join handler only checks the room token when this secret is
/// non-empty, so an empty one is not a weaker configuration but NO access control. Refusing to boot
/// makes the misconfiguration an outage that names the variable, instead of an open door.
fn require_room_secret(raw: Option<String>) -> anyhow::Result<String> {
    match raw.map(|v| v.trim().to_string()).filter(|v| !v.is_empty()) {
        Some(secret) => Ok(secret),
        None => {
            error!("CALL_ROOM_SECRET is not set or empty - refusing to start: room access control would be disabled");
            anyhow::bail!(
                "CALL_ROOM_SECRET must be set to a non-empty value (it signs the room tokens chat-delivery-service issues)"
            )
        }
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt::init();

    let jwt_secret = std::env::var("JWT_SECRET").unwrap_or_else(|_| {
        warn!("JWT_SECRET not set - WebSocket auth will reject all connections");
        String::new()
    });

    // FAIL CLOSED: an empty secret used to switch room access control OFF, so any authenticated
    // user could join any room. Every estate sets it (env-manifest.tsv, the local compose), so the
    // service refuses to start rather than run open.
    let call_room_secret = require_room_secret(std::env::var("CALL_ROOM_SECRET").ok())?;

    let state = Arc::new(AppState {
        rooms: DashMap::new(),
        p2p_rooms: DashMap::new(),
        jwt_secret,
        call_room_secret,
    });

    // Background task: evict rooms idle for more than 30 minutes.
    tokio::spawn(cleanup_stale_rooms(state.clone()));

    let app = Router::new()
        .route("/ws", get(ws_handler))
        .route("/api/health", get(health_handler))
        .with_state(state);

    let port = std::env::var("PORT").unwrap_or_else(|_| "3004".to_string());
    let addr = format!("0.0.0.0:{}", port);
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    // The BOUND address, not the requested one: with `PORT=0` the kernel picks the port, and this
    // line is how `tests/p2p_signalling.rs` learns it - a port no other test can have taken.
    info!("Call service listening on {}", listener.local_addr()?);
    axum::serve(listener, app).await?;

    Ok(())
}

async fn health_handler() -> impl IntoResponse {
    (StatusCode::OK, "ok")
}

/// Extract a cookie value from the `Cookie` header.
fn extract_cookie_value(headers: &HeaderMap, key: &str) -> Option<String> {
    let cookie_header = headers.get("cookie")?.to_str().ok()?;
    for part in cookie_header.split(';') {
        let trimmed = part.trim();
        if let Some((name, value)) = trimmed.split_once('=') {
            if name.trim() == key {
                return Some(value.trim().to_string());
            }
        }
    }
    None
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    Query(params): Query<AuthParams>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    if state.jwt_secret.is_empty() {
        return (StatusCode::INTERNAL_SERVER_ERROR, "JWT not configured").into_response();
    }

    // Cookie is preferred (same-origin web); query param is the Tauri mobile fallback.
    let token = extract_cookie_value(&headers, "canari_ws_token").or_else(|| {
        params.token.as_deref().map(|t| {
            info!(
                "[ws] Using ?token= fallback (Tauri mobile), prefix={}…",
                t.chars().take(8).collect::<String>()
            );
            t.to_string()
        })
    });

    let Some(token) = token else {
        return (StatusCode::UNAUTHORIZED, "Missing auth token").into_response();
    };

    let validation = Validation::new(Algorithm::HS256);
    let key = DecodingKey::from_secret(state.jwt_secret.as_bytes());

    match decode::<Claims>(&token, &key, &validation) {
        Ok(token_data) => {
            let user_id = token_data.claims.sub;
            info!("Authenticated WebSocket upgrade for user {}", user_id);
            ws.max_message_size(MAX_SIGNAL_MESSAGE_BYTES)
                .max_frame_size(MAX_SIGNAL_MESSAGE_BYTES)
                .on_upgrade(move |socket| handle_socket(socket, state, user_id))
        }
        Err(e) => {
            error!("JWT validation failed: {}", e);
            (StatusCode::UNAUTHORIZED, "Invalid token").into_response()
        }
    }
}

async fn handle_socket(socket: WebSocket, state: Arc<AppState>, user_id: String) {
    let peer_id = format!("{}:{}", user_id, Uuid::new_v4());
    let mut session = PeerSession {
        room_id: None,
        ledger: None,
        mode: RoomMode::Sfu,
    };
    // `interval` fires at once on its first tick; skip it so the first ping goes out one period in.
    let mut keepalive =
        tokio::time::interval_at(tokio::time::Instant::now() + KEEPALIVE, KEEPALIVE);

    let (tx, mut rx) = mpsc::channel::<SignalMessage>(100);

    info!("[call] socket open peer={}", peer_id);

    // Rate limiter: max 50 signal frames per second per peer.
    let mut rate_count: u32 = 0;
    let mut rate_window = std::time::Instant::now();

    let mut writer_socket = socket;

    loop {
        tokio::select! {
            msg = writer_socket.recv() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        // Rate limiting: reset window every second, reject if over 50 msg/s.
                        let now = std::time::Instant::now();
                        if now.duration_since(rate_window) > std::time::Duration::from_secs(1) {
                            rate_count = 0;
                            rate_window = now;
                        }
                        rate_count += 1;
                        if rate_count > 50 {
                            warn!("[rate-limit] Peer {} exceeded 50 msg/s - disconnecting", peer_id);
                            end_session(&session, Disposition::RateLimited);
                            break;
                        }

                        match serde_json::from_str::<SignalMessage>(&text) {
                            Ok(signal) => {
                                handle_signal(&state, &user_id, &peer_id, &mut session, signal, tx.clone()).await;
                            }
                            Err(e) => error!("[call] {} unparseable signal frame: {}", peer_id, e),
                        }
                    }
                    // The four ways a socket ends were one silent `break` each. They are not the
                    // same event: a Close frame is a user hanging up, an error is the network
                    // going away mid-call, and no client's own log can tell those two apart.
                    Some(Ok(Message::Close(frame))) => {
                        info!(
                            "[call] {} sent Close ({})",
                            peer_id,
                            frame
                                .as_ref()
                                .map(|f| format!("code={} reason={}", f.code, f.reason))
                                .unwrap_or_else(|| "no payload".to_string())
                        );
                        end_session(&session, Disposition::ClientClose);
                        break;
                    }
                    Some(Err(e)) => {
                        warn!("[call] {} socket error: {}", peer_id, e);
                        end_session(&session, Disposition::TransportError);
                        break;
                    }
                    None => {
                        warn!("[call] {} stream ended without a Close frame", peer_id);
                        end_session(&session, Disposition::StreamEnded);
                        break;
                    }
                    _ => {}
                }
            }
            _ = keepalive.tick() => {
                // A Ping frame, answered by the browser's own Pong; nothing in the page sees it.
                if let Err(e) = writer_socket.send(Message::Ping(Default::default())).await {
                    warn!("[call] {} keepalive ping failed: {}", peer_id, e);
                    end_session(&session, Disposition::SendFailed);
                    break;
                }
            }
            Some(msg) = rx.recv() => {
                // A frame we cannot serialise is dropped and named, never panicked on: this is
                // the writer for every outbound signal and it must not take the call down.
                let text = match serde_json::to_string(&msg) {
                    Ok(text) => text,
                    Err(e) => {
                        error!("[call] {} could not serialise outbound {}: {}", peer_id, msg.kind(), e);
                        continue;
                    }
                };
                // `.into()`: axum 0.8 carries text frames as `Utf8Bytes`, not `String`.
                if let Err(e) = writer_socket.send(Message::Text(text.into())).await {
                    error!("[call] {} socket write failed on {}: {}", peer_id, msg.kind(), e);
                    end_session(&session, Disposition::SendFailed);
                    break;
                }
            }
        }
    }

    if let (Some(room_id), RoomMode::P2p) = (session.room_id.clone(), session.mode) {
        p2p_leave(&state, &room_id, &peer_id).await;
    } else if let Some(room_id) = session.room_id.clone() {
        let remove_room = if let Some(room) = state.rooms.get(&room_id) {
            // Close the PeerConnection rather than only dropping it: webrtc-rs holds the ICE
            // agent and its TURN allocation until told to let go, and a relay allocation left
            // running is billed against the same monthly budget the ICE endpoint guards.
            // `evict_sibling_peers` already did this; the ordinary hangup path did not, so the
            // record below would have said "session end" while the allocation was still live.
            if let Some((_, ctx)) = room.peers.remove(&peer_id) {
                if let Err(e) = ctx.pc.close().await {
                    warn!("[call] {} failed to close peer connection: {}", peer_id, e);
                }
            }
            room.peers.is_empty()
        } else {
            warn!(
                "[call] {} left room {} but the room was already gone",
                peer_id, room_id
            );
            false
        };
        if remove_room {
            state.rooms.remove(&room_id);
            info!("[call] room {} removed - no peers remaining", room_id);
        }
    }

    match &session.ledger {
        // The record: one line carrying which frames crossed the SFU in each direction, how
        // long the peer held the room, and whether media ever flowed at all.
        Some(ledger) => ledger.emit(),
        // No ledger means the socket authenticated and never joined a room. It still gets a
        // line, because "socket open" without a closing line is a pair a reader has to guess at.
        None => info!(
            "[call] socket closed peer={} without joining a room",
            peer_id
        ),
    }
}

async fn handle_signal(
    state: &Arc<AppState>,
    user_id: &str,
    peer_id: &String,
    session: &mut PeerSession,
    signal: SignalMessage,
    notify_tx: mpsc::Sender<SignalMessage>,
) {
    match signal {
        SignalMessage::Join {
            room_id,
            room_token,
            mode,
        } => {
            let Some(group_id) =
                authorize_join(state, user_id, peer_id, &room_id, room_token.as_deref())
            else {
                return;
            };

            // Reject if peer is already in a room - prevents multi-room joins.
            if let Some(existing) = &session.room_id {
                warn!(
                    "[busy] Peer {} tried to join room {} but is already in room {}",
                    peer_id, room_id, existing
                );
                return;
            }

            // A room id belongs to ONE mode for its whole life. Both maps are keyed by the same
            // server-issued UUID, so a mismatch is a client bug, refused and named rather than
            // silently splitting one call across two designs.
            let other_mode_holds_it = match mode {
                RoomMode::P2p => state.rooms.contains_key(&room_id),
                RoomMode::Sfu => state.p2p_rooms.contains_key(&room_id),
            };
            if other_mode_holds_it {
                warn!(
                    "[call] {} asked for room {} as {} but it exists in the other mode - refused",
                    peer_id,
                    room_id,
                    mode.as_str()
                );
                let _ = notify_tx
                    .send(SignalMessage::Refused {
                        reason: "mode-mismatch".to_string(),
                    })
                    .await;
                return;
            }

            if mode == RoomMode::P2p {
                p2p_join(
                    state, user_id, peer_id, &group_id, session, room_id, notify_tx,
                )
                .await;
                return;
            }

            info!("[call] session start room={} peer={}", room_id, peer_id);
            session.room_id = Some(room_id.clone());
            // The room id is also chat-delivery-service's `callId`, so this ledger and the ring
            // fan-out's `[ring] call=...` lines join on it. Nothing else links the two services.
            let ledger = Arc::new(CallLedger::new(
                room_id.clone(),
                peer_id.clone(),
                RoomMode::Sfu,
            ));
            session.ledger = Some(ledger.clone());

            let room = state
                .rooms
                .entry(room_id.clone())
                .or_insert_with(|| {
                    Arc::new(Room {
                        tracks: Mutex::new(Vec::new()),
                        peers: DashMap::new(),
                        renegotiate_gen: DashMap::new(),
                        last_activity: std::sync::Mutex::new(std::time::Instant::now()),
                    })
                })
                .value()
                .clone();

            // Refresh activity timestamp.
            if let Ok(mut ts) = room.last_activity.lock() {
                *ts = std::time::Instant::now();
            }

            // One SFU participant per user - a new device replaces siblings in the same room.
            evict_sibling_peers(&room, user_id).await;

            let pc = match create_peer_connection().await {
                Ok(pc) => pc,
                Err(e) => {
                    error!("Failed to create peer connection: {}", e);
                    return;
                }
            };

            let pc = Arc::new(pc);
            // Register peer before slow callback wiring so Offer is never dropped.
            room.peers.insert(
                peer_id.clone(),
                PeerContext {
                    pc: pc.clone(),
                    notify_tx: notify_tx.clone(),
                    pending_ice_candidates: Mutex::new(Vec::new()),
                    ledger: ledger.clone(),
                },
            );

            let tracks = room.tracks.lock().await;
            for track in tracks.iter() {
                match pc
                    .add_track(Arc::clone(&track.local) as Arc<dyn TrackLocal + Send + Sync>)
                    .await
                {
                    Err(e) => error!(
                        "[call] room={} peer={} failed to subscribe to an existing track: {}",
                        room_id, peer_id, e
                    ),
                    Ok(sender) if track.is_video => {
                        bump(&ledger.tracks_subscribed);
                        // This peer subscribes to a video track published before it joined,
                        // so it missed the last keyframe: ask the publisher for a fresh IDR now
                        // (otherwise it only gets undecodable delta frames = black video)…
                        request_keyframe_burst(
                            track.publisher_pc.clone(),
                            track.media_ssrc,
                            track.last_pli.clone(),
                        );
                        // …and relay its future keyframe requests to the publisher on demand.
                        forward_pli_from_subscriber(
                            sender,
                            track.publisher_pc.clone(),
                            track.media_ssrc,
                            track.last_pli.clone(),
                        );
                    }
                    Ok(_) => bump(&ledger.tracks_subscribed),
                }
            }
            drop(tracks);

            let notify_tx_clone = notify_tx.clone();
            let ledger_ice = ledger.clone();
            pc.on_ice_candidate(Box::new(move |c| {
                let notify_tx_clone = notify_tx_clone.clone();
                let ledger = ledger_ice.clone();
                Box::pin(async move {
                    // No line per candidate: a call gathers dozens, and the figure that answers
                    // a question is the count at the end of negotiation, not the trickle.
                    let json = match c {
                        Some(c) => match c.to_json() {
                            Ok(j) => j,
                            Err(e) => {
                                bump(&ledger.ice_out_failed);
                                warn!("[ICE] to_json failed for {}: {}", ledger.peer_id, e);
                                return;
                            }
                        },
                        None => RTCIceCandidateInit {
                            candidate: String::new(),
                            sdp_mid: None,
                            sdp_mline_index: None,
                            username_fragment: None,
                        },
                    };
                    let candidate = match serde_json::to_string(&json) {
                        Ok(c) => c,
                        Err(e) => {
                            bump(&ledger.ice_out_failed);
                            warn!(
                                "[ICE] could not serialise candidate for {}: {}",
                                ledger.peer_id, e
                            );
                            return;
                        }
                    };
                    match notify_tx_clone
                        .send(SignalMessage::IceCandidate { candidate })
                        .await
                    {
                        Ok(()) => bump(&ledger.ice_out),
                        Err(e) => {
                            bump(&ledger.ice_out_failed);
                            warn!(
                                "[ICE] failed to send candidate for {}: {}",
                                ledger.peer_id, e
                            );
                        }
                    }
                })
            }));

            let ledger_ice_state = ledger.clone();
            pc.on_ice_connection_state_change(Box::new(move |state| {
                let ledger = ledger_ice_state.clone();
                Box::pin(async move {
                    let name = format!("{:?}", state);
                    ledger.set_ice_state(&name);
                    match state {
                        RTCIceConnectionState::Connected | RTCIceConnectionState::Completed => {
                            match ledger.mark_connected() {
                                Some(took) => info!(
                                    "[call] ice connected room={} peer={} after_ms={} {}",
                                    ledger.room_id,
                                    ledger.peer_id,
                                    took.as_millis(),
                                    ledger.ice_counters()
                                ),
                                None => info!(
                                    "[call] ice {} room={} peer={}",
                                    name, ledger.room_id, ledger.peer_id
                                ),
                            }
                        }
                        RTCIceConnectionState::Failed | RTCIceConnectionState::Disconnected => {
                            // The counts are the whole point of this line: candidates gathered
                            // on both sides with no pair formed is a TURN fault, ice_in=0 is a
                            // client that never trickled, and the two look identical without it.
                            warn!(
                                "[call] ice {} room={} peer={} connected_ms={} {}",
                                name,
                                ledger.room_id,
                                ledger.peer_id,
                                ledger
                                    .connected_ms()
                                    .map(|ms| ms.to_string())
                                    .unwrap_or_else(|| "-".to_string()),
                                ledger.ice_counters()
                            );
                        }
                        _ => info!(
                            "[call] ice {} room={} peer={}",
                            name, ledger.room_id, ledger.peer_id
                        ),
                    }
                })
            }));

            let room_clone = room.clone();
            let peer_id_clone = peer_id.clone();
            let ledger_track = ledger.clone();
            // Weak ref (not a clone) so the PLI task below doesn't keep the publisher's
            // PeerConnection alive in a reference cycle (pc owns the on_track callback).
            let pc_weak = Arc::downgrade(&pc);
            pc.on_track(Box::new(
                move |track: Arc<TrackRemote>, _receiver, _transceiver| {
                    let room_clone = room_clone.clone();
                    let peer_id_clone = peer_id_clone.clone();
                    let pc_weak = pc_weak.clone();
                    let ledger = ledger_track.clone();

                    Box::pin(async move {
                        let remote_track = track;
                        bump(&ledger.tracks_published);
                        info!(
                            "[call] track published room={} peer={} kind={}",
                            ledger.room_id,
                            peer_id_clone,
                            remote_track.kind()
                        );

                        let local_track = Arc::new(TrackLocalStaticRTP::new(
                            remote_track.codec().capability.clone(),
                            format!("track-{}-{}", peer_id_clone, Uuid::new_v4()),
                            "canari-sfu".to_owned(),
                        ));

                        let is_video = remote_track.kind() == RTPCodecType::Video;
                        let media_ssrc = remote_track.ssrc();
                        let last_pli = Arc::new(std::sync::Mutex::new(std::time::Instant::now()));

                        {
                            let mut room_tracks = room_clone.tracks.lock().await;
                            room_tracks.push(PublishedTrack {
                                local: local_track.clone(),
                                publisher_pc: pc_weak.clone(),
                                media_ssrc,
                                is_video,
                                last_pli: last_pli.clone(),
                            });
                        }

                        let local_track_clone = local_track.clone();

                        // RTP forwarding loop - never interrupted, so no packet is dropped.
                        tokio::spawn(async move {
                            let mut buf = vec![0u8; 1500];
                            while let Ok((parsed, _)) = remote_track.read(&mut buf).await {
                                if local_track_clone.write_rtp(&parsed).await.is_err() {
                                    break;
                                }
                            }
                        });

                        // Keyframes are mostly requested on demand (forward_pli_from_subscriber,
                        // when a subscriber attaches below). A slow recovery timer additionally
                        // guards against a relayed PLI being lost on the TURN path, which would
                        // otherwise freeze the picture indefinitely on a lossy mobile uplink.
                        if is_video {
                            periodic_keyframe_recovery(
                                pc_weak.clone(),
                                media_ssrc,
                                last_pli.clone(),
                            );
                        }

                        for peer_entry in room_clone.peers.iter() {
                            let other_pid = peer_entry.key();
                            if other_pid == &peer_id_clone {
                                continue;
                            }

                            let other_ctx = peer_entry.value();
                            match other_ctx
                                .pc
                                .add_track(
                                    Arc::clone(&local_track) as Arc<dyn TrackLocal + Send + Sync>
                                )
                                .await
                            {
                                Err(e) => {
                                    error!(
                                        "[call] room={} peer={} could not be subscribed to the new track: {}",
                                        ledger.room_id, other_pid, e
                                    );
                                    continue;
                                }
                                Ok(sender) if is_video => {
                                    bump(&other_ctx.ledger.tracks_subscribed);
                                    // Existing subscriber gets this freshly-published video track:
                                    // nudge a keyframe now and relay its later requests on demand.
                                    request_keyframe_burst(
                                        pc_weak.clone(),
                                        media_ssrc,
                                        last_pli.clone(),
                                    );
                                    forward_pli_from_subscriber(
                                        sender,
                                        pc_weak.clone(),
                                        media_ssrc,
                                        last_pli.clone(),
                                    );
                                }
                                Ok(_) => bump(&other_ctx.ledger.tracks_subscribed),
                            }

                            schedule_renegotiate(room_clone.clone(), other_pid.clone());
                        }
                    })
                },
            ));

            if let Err(e) = notify_tx
                .send(SignalMessage::Joined {
                    room_id: room_id.clone(),
                })
                .await
            {
                error!(
                    "[call] joined ack NOT sent room={} peer={}: {} - this peer will never offer",
                    room_id, peer_id, e
                );
            }
        }
        SignalMessage::Offer { sdp } if session.mode == RoomMode::P2p => {
            p2p_relay(
                state,
                session,
                peer_id,
                RelayedKind::Offer,
                SignalMessage::Offer { sdp },
            )
            .await;
        }
        SignalMessage::Answer { sdp } if session.mode == RoomMode::P2p => {
            p2p_relay(
                state,
                session,
                peer_id,
                RelayedKind::Answer,
                SignalMessage::Answer { sdp },
            )
            .await;
        }
        SignalMessage::IceCandidate { candidate } if session.mode == RoomMode::P2p => {
            p2p_relay(
                state,
                session,
                peer_id,
                RelayedKind::Ice,
                SignalMessage::IceCandidate { candidate },
            )
            .await;
        }
        SignalMessage::Offer { sdp } => {
            let Some((room_id, room)) = resolve_room(state, session, peer_id, "offer") else {
                return;
            };
            let Some(ctx) = resolve_peer(&room, session, peer_id, &room_id, "offer") else {
                return;
            };
            bump(&ctx.ledger.offers_in);

            let sdp_obj = match serde_json::from_str::<RTCSessionDescription>(&sdp) {
                Ok(obj) => obj,
                Err(e) => {
                    error!(
                        "[call] offer room={} peer={} is not valid SDP JSON: {}",
                        room_id, peer_id, e
                    );
                    return;
                }
            };
            if let Err(e) = ctx.pc.set_remote_description(sdp_obj).await {
                error!(
                    "[call] set_remote_description(offer) failed room={} peer={}: {}",
                    room_id, peer_id, e
                );
                return;
            }

            flush_pending_ice_candidates(ctx.value()).await;

            let answer = match ctx.pc.create_answer(None).await {
                Ok(answer) => answer,
                Err(e) => {
                    error!(
                        "[call] create_answer failed room={} peer={}: {}",
                        room_id, peer_id, e
                    );
                    return;
                }
            };
            if let Err(e) = ctx.pc.set_local_description(answer.clone()).await {
                error!(
                    "[call] set_local_description(answer) failed room={} peer={}: {}",
                    room_id, peer_id, e
                );
                return;
            }
            let sdp = match serde_json::to_string(&answer) {
                Ok(sdp) => sdp,
                Err(e) => {
                    error!(
                        "[call] could not serialise answer room={} peer={}: {}",
                        room_id, peer_id, e
                    );
                    return;
                }
            };
            // Counted when the frame reaches the socket writer, not the wire. A write that fails
            // ends the session as `send-failed`, which is the other half of the same question:
            // the peer offered, and either the answer left or the record says it did not.
            match ctx.notify_tx.send(SignalMessage::Answer { sdp }).await {
                Ok(()) => {
                    bump(&ctx.ledger.answers_out);
                    info!("[call] answer sent room={} peer={}", room_id, peer_id);
                }
                Err(e) => error!(
                    "[call] answer NOT sent room={} peer={}: {} - this peer offered and got nothing back",
                    room_id, peer_id, e
                ),
            }
        }
        SignalMessage::Answer { sdp } => {
            let Some((room_id, room)) = resolve_room(state, session, peer_id, "answer") else {
                return;
            };
            let Some(ctx) = resolve_peer(&room, session, peer_id, &room_id, "answer") else {
                return;
            };
            bump(&ctx.ledger.answers_in);

            let sdp_obj = match serde_json::from_str::<RTCSessionDescription>(&sdp) {
                Ok(obj) => obj,
                Err(e) => {
                    // Silent before this: a renegotiation answer that would not parse left the
                    // SFU offering into a void, with nothing anywhere saying the answer arrived.
                    error!(
                        "[call] answer room={} peer={} is not valid SDP JSON: {}",
                        room_id, peer_id, e
                    );
                    return;
                }
            };
            if let Err(e) = ctx.pc.set_remote_description(sdp_obj).await {
                error!(
                    "[call] set_remote_description(answer) failed room={} peer={}: {}",
                    room_id, peer_id, e
                );
                return;
            }
            flush_pending_ice_candidates(ctx.value()).await;
            info!(
                "[call] renegotiation answer applied room={} peer={}",
                room_id, peer_id
            );
        }
        SignalMessage::IceCandidate { candidate } => {
            let Some((room_id, room)) = resolve_room(state, session, peer_id, "ice") else {
                return;
            };
            let Some(ctx) = resolve_peer(&room, session, peer_id, &room_id, "ice") else {
                return;
            };
            bump(&ctx.ledger.ice_in);

            match serde_json::from_str::<RTCIceCandidateInit>(&candidate) {
                Ok(cand) => apply_remote_ice_candidate(peer_id, ctx.value(), cand).await,
                Err(e) => {
                    bump(&ctx.ledger.ice_in_failed);
                    warn!(
                        "[call] ice room={} peer={} is not valid candidate JSON: {}",
                        room_id, peer_id, e
                    );
                }
            }
        }
        SignalMessage::Joined { .. }
        | SignalMessage::PeerReady { .. }
        | SignalMessage::PeerLeft
        | SignalMessage::Refused { .. } => {
            // Server -> client only. A client sending one is confused, and the line says which.
            warn!(
                "[call] {} sent server-only frame {} - dropped",
                peer_id,
                signal.kind()
            );
        }
    }
}

/// Checks a `Join`'s room token: signed by chat-delivery-service with `CALL_ROOM_SECRET`, for THIS
/// room and THIS user. Every refusal is named, because a refused Join is otherwise a client waiting
/// out its timeout with nothing anywhere saying why.
///
/// Returns the token's `group_id` when the token is good: the group is what a peer-to-peer room
/// compares between its two seats.
fn authorize_join(
    state: &Arc<AppState>,
    user_id: &str,
    peer_id: &str,
    room_id: &str,
    room_token: Option<&str>,
) -> Option<String> {
    let Some(token) = room_token else {
        warn!(
            "[auth] Peer {} attempted Join without room_token - rejected",
            peer_id
        );
        return None;
    };
    let key = DecodingKey::from_secret(state.call_room_secret.as_bytes());
    let validation = Validation::new(Algorithm::HS256);
    match decode::<RoomClaims>(token, &key, &validation) {
        Ok(data) if data.claims.room_id != room_id => {
            warn!(
                "[auth] Peer {} room_id mismatch: token={} requested={}",
                peer_id, data.claims.room_id, room_id
            );
            None
        }
        Ok(data) if data.claims.sub != user_id => {
            warn!(
                "[auth] Peer {} user_id mismatch: token={} ws={}",
                peer_id, data.claims.sub, user_id
            );
            None
        }
        Ok(data) => Some(data.claims.group_id),
        Err(e) => {
            warn!("[auth] Peer {} invalid room_token: {}", peer_id, e);
            None
        }
    }
}

/// Seats a peer in a peer-to-peer room and tells each party what to do next.
///
/// The decision is taken inside the map's entry guard, so a concurrent last-peer-leaves cannot
/// remove the room between our lookup and our seat (see [`p2p_leave`], which removes under the
/// same shard lock).
async fn p2p_join(
    state: &Arc<AppState>,
    user_id: &str,
    peer_id: &str,
    group_id: &str,
    session: &mut PeerSession,
    room_id: RoomId,
    notify_tx: mpsc::Sender<SignalMessage>,
) {
    let ledger = Arc::new(CallLedger::new(
        room_id.clone(),
        peer_id.to_string(),
        RoomMode::P2p,
    ));
    let me = P2pPeer {
        peer_id: peer_id.to_string(),
        user_id: user_id.to_string(),
        group_id: group_id.to_string(),
        tx: notify_tx.clone(),
        ledger: ledger.clone(),
    };
    let outcome = {
        let room = state.p2p_rooms.entry(room_id.clone()).or_default();
        room.value().join(me)
    };

    let (initiator, evicted) = match outcome {
        JoinOutcome::Full => {
            warn!(
                "[call] {} refused from p2p room {}: two other users already hold it",
                peer_id, room_id
            );
            let _ = notify_tx
                .send(SignalMessage::Refused {
                    reason: "room-full".to_string(),
                })
                .await;
            return;
        }
        JoinOutcome::OtherGroup => {
            // A valid token for THIS room id but another conversation: someone who learnt the id
            // and holds a token minted elsewhere. Seated, it would receive the call's candidates.
            warn!(
                "[auth] {} refused from p2p room {}: its token names group {}, the room holds another",
                peer_id, room_id, group_id
            );
            let _ = notify_tx
                .send(SignalMessage::Refused {
                    reason: "group-mismatch".to_string(),
                })
                .await;
            return;
        }
        JoinOutcome::Waiting { evicted } => (None, evicted),
        JoinOutcome::Paired { initiator, evicted } => (Some(initiator), evicted),
    };

    info!(
        "[call] session start room={} peer={} mode=p2p",
        room_id, peer_id
    );
    session.room_id = Some(room_id.clone());
    session.mode = RoomMode::P2p;
    session.ledger = Some(ledger.clone());

    for gone in evicted {
        // The FIRST cause wins on its record; its socket's later Close must not overwrite it.
        gone.ledger.end(Disposition::SiblingEvicted);
        info!(
            "[multi-device] p2p room {}: {} replaced by {}",
            room_id, gone.peer_id, peer_id
        );
        if let Err(e) = gone.tx.send(SignalMessage::PeerLeft).await {
            warn!(
                "[multi-device] could not tell replaced peer {} it left: {}",
                gone.peer_id, e
            );
        }
    }

    if let Err(e) = notify_tx
        .send(SignalMessage::Joined {
            room_id: room_id.clone(),
        })
        .await
    {
        error!(
            "[call] joined ack NOT sent room={} peer={}: {}",
            room_id, peer_id, e
        );
        return;
    }

    let Some(initiator) = initiator else {
        return;
    };
    // Both records mark the pairing: `paired_ms` on each is measured from its own Join.
    initiator.ledger.mark_connected();
    ledger.mark_connected();
    info!(
        "[call] p2p paired room={} initiator={} polite={}",
        room_id, initiator.peer_id, peer_id
    );
    for (tx, is_initiator, who) in [
        (&initiator.tx, true, initiator.peer_id.as_str()),
        (&notify_tx, false, peer_id),
    ] {
        if let Err(e) = tx
            .send(SignalMessage::PeerReady {
                initiator: is_initiator,
            })
            .await
        {
            error!(
                "[call] peer-ready NOT sent room={} peer={}: {} - this call cannot negotiate",
                room_id, who, e
            );
        }
    }
}

/// Forwards one handshake frame to the other party of a peer-to-peer room.
async fn p2p_relay(
    state: &Arc<AppState>,
    session: &PeerSession,
    peer_id: &str,
    kind: RelayedKind,
    frame: SignalMessage,
) {
    let Some(room_id) = session.room_id.as_ref() else {
        warn!(
            "[call] {} sent {} before Join completed - dropped",
            peer_id,
            frame.kind()
        );
        return;
    };
    let Some(room) = state.p2p_rooms.get(room_id).map(|r| r.value().clone()) else {
        warn!(
            "[call] {} sent {} for p2p room {}, which no longer exists - dropped",
            peer_id,
            frame.kind(),
            room_id
        );
        return;
    };
    let Some(partner) = room.partner_of(peer_id) else {
        // Two benign cases, kept apart: an evicted device still trickling (already explained by
        // its record), and a peer alone in the room - which the client should never produce,
        // since it offers only on `PeerReady`.
        if room.contains(peer_id) {
            if let Some(ledger) = &session.ledger {
                bump(&ledger.ice_in_failed);
            }
            warn!(
                "[call] {} sent {} in p2p room {} with nobody to receive it - dropped",
                peer_id,
                frame.kind(),
                room_id
            );
        }
        return;
    };
    let name = frame.kind();
    match p2p::deliver(&partner, frame) {
        Ok(()) => {
            if let Some(ledger) = &session.ledger {
                count_relayed(kind, ledger, &partner.ledger);
            }
            if kind != RelayedKind::Ice {
                info!(
                    "[call] p2p {} relayed room={} from={} to={}",
                    name, room_id, peer_id, partner.peer_id
                );
            }
        }
        Err(e) => {
            // Counted only for ICE, the one kind that column was written for; a dropped offer or
            // answer is rarer and fatal to the negotiation, and this line carries it.
            if kind == RelayedKind::Ice {
                bump(&partner.ledger.ice_out_failed);
            }
            warn!(
                "[call] p2p {} DROPPED room={} from={} to={}: {}",
                name,
                room_id,
                peer_id,
                partner.peer_id,
                e.as_str()
            );
        }
    }
}

/// Removes a peer from its peer-to-peer room when its socket ends, tells the party left behind,
/// and drops the room once it is empty - atomically, under the map's shard lock, so a join racing
/// the last leave either lands before the removal or creates a fresh room after it.
async fn p2p_leave(state: &Arc<AppState>, room_id: &str, peer_id: &str) {
    let mut remaining: Option<P2pPeer> = None;
    let removed = state.p2p_rooms.remove_if(room_id, |_, room| {
        remaining = room.leave(peer_id);
        room.is_empty()
    });
    if removed.is_some() {
        info!("[call] p2p room {} removed - no peers remaining", room_id);
    }
    if let Some(other) = remaining {
        if let Err(e) = other.tx.send(SignalMessage::PeerLeft).await {
            warn!(
                "[call] could not tell {} that {} left room {}: {}",
                other.peer_id, peer_id, room_id, e
            );
        }
    }
}

#[derive(Debug, Deserialize)]
struct CloudflareIceResponse {
    #[serde(rename = "iceServers")]
    ice_servers: Vec<CloudflareIceServer>,
}

#[derive(Debug, Deserialize)]
struct CloudflareIceServer {
    urls: serde_json::Value,
    username: Option<String>,
    credential: Option<String>,
}

fn urls_include_turn(urls: &[String]) -> bool {
    urls.iter()
        .any(|u| u.starts_with("turn:") || u.starts_with("turns:"))
}

/// Returns true when Cloudflare (or env) gave a URL that webrtc-rs must not use.
fn ice_url_blocked_for_sfu(url: &str) -> bool {
    if url.starts_with("stun:") {
        return false;
    }
    if !url.starts_with("turn:") || url.starts_with("turns:") {
        return true;
    }
    if url.contains("transport=tcp") {
        return true;
    }
    // Port 53 (DNS) - blocked in browsers; webrtc-rs TURN client fails allocation.
    if url.contains(":53?") || url.ends_with(":53") {
        return true;
    }
    if url.contains(":80?")
        || url.ends_with(":80")
        || url.contains(":443?")
        || url.ends_with(":443")
    {
        return true;
    }
    false
}

/// webrtc-rs only supports TURN/UDP on standard ports; Cloudflare returns tcp/tls/53 too.
fn filter_urls_for_sfu(urls: Vec<String>) -> Vec<String> {
    let before = urls.len();
    let filtered: Vec<String> = urls
        .into_iter()
        .filter(|u| !ice_url_blocked_for_sfu(u))
        .collect();
    if filtered.len() < before {
        warn!(
            "[ICE] dropped {} URL(s) unusable by SFU (port 53, tcp, or tls)",
            before - filtered.len()
        );
    }
    filtered
}

/// Debounces SFU→client offers when several tracks arrive at once (e.g. audio + video).
fn schedule_renegotiate(room: Arc<Room>, target_peer_id: PeerId) {
    let generation = {
        let mut entry = room
            .renegotiate_gen
            .entry(target_peer_id.clone())
            .or_insert(0);
        *entry += 1;
        *entry
    };

    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;

        let still_current = room
            .renegotiate_gen
            .get(&target_peer_id)
            .map(|g| *g == generation)
            .unwrap_or(false);
        if !still_current {
            return;
        }

        let Some(ctx) = room.peers.get(&target_peer_id) else {
            info!(
                "[call] renegotiation dropped: peer {} left before the debounce fired",
                target_peer_id
            );
            return;
        };

        let offer = match ctx.pc.create_offer(None).await {
            Ok(offer) => offer,
            Err(e) => {
                error!(
                    "[call] renegotiation create_offer failed peer={}: {}",
                    target_peer_id, e
                );
                return;
            }
        };
        if let Err(e) = ctx.pc.set_local_description(offer.clone()).await {
            error!(
                "[call] renegotiation set_local_description failed peer={}: {}",
                target_peer_id, e
            );
            return;
        }
        let sdp = match serde_json::to_string(&offer) {
            Ok(sdp) => sdp,
            Err(e) => {
                error!(
                    "[call] could not serialise renegotiation offer peer={}: {}",
                    target_peer_id, e
                );
                return;
            }
        };
        match ctx.notify_tx.send(SignalMessage::Offer { sdp }).await {
            Ok(()) => {
                bump(&ctx.ledger.offers_out);
                info!(
                    "[call] renegotiation offer sent room={} peer={} (signaling={:?})",
                    ctx.ledger.room_id,
                    target_peer_id,
                    ctx.pc.signaling_state()
                );
            }
            // The subscriber never learns the room gained a track: its video simply never
            // appears, and nothing on either client says why.
            Err(e) => error!(
                "[call] renegotiation offer NOT sent peer={}: {}",
                target_peer_id, e
            ),
        }
    });
}

/// Builds an `RTCIceServer` for webrtc-rs.
///
/// webrtc-rs 0.17 dropped `RTCIceServer::credential_type`, following the W3C spec, which removed
/// `RTCIceCredentialType` once `password` became the only value. The rule it encoded is now enforced
/// inside the crate: `RTCIceServer::urls()` returns `ErrNoTurnCredentials` for a `turn:`/`turns:` URL
/// whose username or credential is empty. Before 0.17 that same input produced an `Unspecified`
/// credential type the crate accepted, so a misconfigured TURN entry used to degrade quietly and now
/// fails the whole peer connection - hence the warning: this is the only place that can still name
/// WHICH server was wrong.
fn build_rtc_ice_server(
    urls: Vec<String>,
    username: Option<String>,
    credential: Option<String>,
) -> RTCIceServer {
    let username = username.unwrap_or_default();
    let credential = credential.unwrap_or_default();
    if urls_include_turn(&urls) && (username.is_empty() || credential.is_empty()) {
        warn!(
            "[call] TURN server {:?} has no credentials (username empty: {}, credential empty: {}) - webrtc-rs rejects the whole ICE configuration for this",
            urls,
            username.is_empty(),
            credential.is_empty()
        );
    }
    RTCIceServer {
        urls,
        username,
        credential,
    }
}

/// Mint short-lived TURN credentials from Cloudflare (same API as chat-delivery clients).
async fn fetch_cloudflare_ice_servers() -> Option<Vec<RTCIceServer>> {
    let api_token = std::env::var("CLOUDFLARE_CALLS_API_TOKEN")
        .ok()
        .filter(|s| !s.trim().is_empty())?;
    let turn_key_id = std::env::var("CLOUDFLARE_TURN_KEY_ID")
        .ok()
        .filter(|s| !s.trim().is_empty())?;

    // A MALFORMED TTL IS NOT AN ABSENT ONE. `and_then(parse().ok())` turned `CLOUDFLARE_TURN_TTL=
    // 7200s` into the default and said nothing, so a deployment that thought it had asked for two
    // hours got one, and the only way to find out was to time a credential expiring.
    let ttl: u64 = match std::env::var("CLOUDFLARE_TURN_TTL_SECONDS") {
        Ok(raw) => raw.parse().unwrap_or_else(|e| {
            warn!("[ICE] CLOUDFLARE_TURN_TTL_SECONDS={raw:?} is not a number ({e}) - using 3600");
            3600
        }),
        Err(_) => 3600,
    };

    let url = format!(
        "https://rtc.live.cloudflare.com/v1/turn/keys/{}/credentials/generate-ice-servers",
        turn_key_id
    );

    let client = reqwest::Client::new();
    // ACCUSES RATHER THAN RETURNING `None`. Both of the `.ok()?` in this function used to make an
    // outage, an expired token and a changed response shape indistinguishable from "TURN is not
    // configured here" - the same `None`, no line, and a silent slide into `ice_servers_from_env`.
    // A relay path that quietly is not there is the one failure this service cannot afford to
    // discover from a user saying a call did not connect.
    let response = match client
        .post(&url)
        .header("Authorization", format!("Bearer {}", api_token))
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({ "ttl": ttl }))
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            error!("[ICE] Cloudflare TURN API unreachable ({e}) - falling back to the env servers");
            return None;
        }
    };

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        error!(
            "[ICE] Cloudflare TURN API failed status={} body={}",
            status,
            body.chars().take(200).collect::<String>()
        );
        return None;
    }

    let data: CloudflareIceResponse = match response.json().await {
        Ok(d) => d,
        Err(e) => {
            error!(
                "[ICE] Cloudflare TURN API answered 2xx with a body this service cannot read ({e})                  - falling back to the env servers"
            );
            return None;
        }
    };
    let servers: Vec<RTCIceServer> = data
        .ice_servers
        .into_iter()
        .filter_map(|entry| {
            let urls: Vec<String> = match &entry.urls {
                serde_json::Value::String(u) => vec![u.clone()],
                serde_json::Value::Array(arr) => arr
                    .iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect(),
                _ => return None,
            };
            let urls = filter_urls_for_sfu(urls);
            if urls.is_empty() {
                return None;
            }
            Some(build_rtc_ice_server(urls, entry.username, entry.credential))
        })
        .collect();

    if servers.is_empty() {
        error!("[ICE] Cloudflare returned no usable ICE servers for SFU");
        return None;
    }

    info!(
        "[ICE] SFU using {} Cloudflare TURN server(s)",
        servers.len()
    );
    Some(servers)
}

/// Static TURN from env when Cloudflare is not configured (dev only).
fn ice_servers_from_env() -> Vec<RTCIceServer> {
    let turn_url = std::env::var("TURN_URL").ok();
    let turn_user = std::env::var("TURN_USERNAME").unwrap_or_default();
    let turn_cred = std::env::var("TURN_CREDENTIAL").unwrap_or_default();

    if let Some(urls_raw) = turn_url.filter(|s| !s.trim().is_empty()) {
        // NO DEFAULT CREDENTIAL: a guessable `user`/`password` pair is a TURN relay anyone can use.
        // A TURN_URL without both credentials is a misconfiguration, accused here and not papered over.
        if turn_user.is_empty() || turn_cred.is_empty() {
            error!("[ICE] TURN_URL is set but TURN_USERNAME / TURN_CREDENTIAL are not - the static TURN server is IGNORED");
        } else {
            let urls: Vec<String> = urls_raw
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
            if !urls.is_empty() {
                info!("SFU using TURN_URL env ({} URL(s))", urls.len());
                return vec![build_rtc_ice_server(urls, Some(turn_user), Some(turn_cred))];
            }
        }
    }

    warn!("SFU has no Cloudflare/TURN config - STUN only; relay-only clients may not connect");
    vec![RTCIceServer {
        urls: vec!["stun:stun.l.google.com:19302".to_owned()],
        ..Default::default()
    }]
}

/// Applies or buffers a remote ICE candidate until the Offer/Answer SDP is set.
async fn apply_remote_ice_candidate(peer_id: &str, ctx: &PeerContext, cand: RTCIceCandidateInit) {
    let is_end = cand.candidate.is_empty();
    if ctx.pc.remote_description().await.is_none() {
        if is_end {
            return;
        }
        let n = {
            let mut pending = ctx.pending_ice_candidates.lock().await;
            // Hard cap: drop candidates if the buffer overflows (prevents memory leak when
            // Offer never arrives - e.g. abandoned connections).
            if pending.len() >= 200 {
                let dropped = pending.len() as u32;
                warn!(
                    "[ICE] {} candidate buffer overflow (>=200) - clearing buffer",
                    peer_id
                );
                pending.clear();
                ctx.ledger
                    .ice_in_failed
                    .fetch_add(dropped, Ordering::Relaxed);
                return;
            }
            pending.push(cand);
            pending.len()
        };
        bump(&ctx.ledger.ice_in_buffered);
        if n <= 3 || n % 50 == 0 {
            info!("[ICE] {} buffered remote candidate (#{})", peer_id, n);
        }
        return;
    }

    if let Err(e) = ctx.pc.add_ice_candidate(cand).await {
        bump(&ctx.ledger.ice_in_failed);
        warn!("[ICE] {} add_ice_candidate failed: {}", peer_id, e);
    } else if is_end {
        info!("[ICE] {} remote end-of-candidates", peer_id);
    }
}

/// Drains candidates received before `set_remote_description`.
async fn flush_pending_ice_candidates(ctx: &PeerContext) {
    let pending: Vec<RTCIceCandidateInit> = {
        let mut guard = ctx.pending_ice_candidates.lock().await;
        std::mem::take(&mut *guard)
    };
    if pending.is_empty() {
        return;
    }
    info!(
        "[ICE] {} flushing {} buffered candidate(s)",
        ctx.ledger.peer_id,
        pending.len()
    );
    for cand in pending {
        if let Err(e) = ctx.pc.add_ice_candidate(cand).await {
            bump(&ctx.ledger.ice_in_failed);
            warn!(
                "[ICE] {} flush add_ice_candidate failed: {}",
                ctx.ledger.peer_id, e
            );
        }
    }
}

async fn resolve_ice_servers() -> Vec<RTCIceServer> {
    if let Some(servers) = fetch_cloudflare_ice_servers().await {
        return servers;
    }
    ice_servers_from_env()
}

/// Periodically removes rooms that have had no signal activity for more than 30 minutes.
async fn cleanup_stale_rooms(state: Arc<AppState>) {
    let mut interval = tokio::time::interval(std::time::Duration::from_secs(300));
    loop {
        interval.tick().await;
        // Two phases, because closing a PeerConnection is async and `retain` is not - and a room
        // reaped without closing its peers leaves their TURN allocations running against the
        // very budget the ICE endpoint refuses credentials to protect.
        let stale: Vec<RoomId> = state
            .rooms
            .iter()
            .filter(|entry| {
                entry
                    .value()
                    .last_activity
                    .lock()
                    .map(|ts| ts.elapsed() > std::time::Duration::from_secs(1800))
                    .unwrap_or(false)
            })
            .map(|entry| entry.key().clone())
            .collect();

        for room_id in stale {
            let Some((_, room)) = state.rooms.remove(&room_id) else {
                continue;
            };
            let idle = room
                .last_activity
                .lock()
                .map(|ts| ts.elapsed())
                .unwrap_or(std::time::Duration::ZERO);
            let peers: Vec<PeerId> = room.peers.iter().map(|e| e.key().clone()).collect();
            for peer_id in &peers {
                if let Some((_, ctx)) = room.peers.remove(peer_id) {
                    ctx.ledger.end(Disposition::RoomReaped);
                    if let Err(e) = ctx.pc.close().await {
                        warn!(
                            "[cleanup] failed to close {} in reaped room {}: {}",
                            peer_id, room_id, e
                        );
                    }
                }
            }
            if peers.is_empty() {
                info!(
                    "[cleanup] evicted stale empty room {} (idle {:.0}s)",
                    room_id,
                    idle.as_secs_f32()
                );
            } else {
                // Not an empty room being tidied away: these sockets still believe they are in a
                // call, and each one's record will now say so rather than blaming its client.
                warn!(
                    "[cleanup] evicted stale room {} (idle {:.0}s) with {} peer(s) still in it",
                    room_id,
                    idle.as_secs_f32(),
                    peers.len()
                );
            }
        }
    }
}

/// Returns the user id prefix from a peer id (`{user_id}:{uuid}`).
fn user_id_from_peer(peer_id: &str) -> &str {
    peer_id.split(':').next().unwrap_or(peer_id)
}

/// Removes other peers belonging to the same user so only one device is in the room.
async fn evict_sibling_peers(room: &Arc<Room>, user_id: &str) {
    let siblings: Vec<String> = room
        .peers
        .iter()
        .filter(|entry| user_id_from_peer(entry.key()) == user_id)
        .map(|entry| entry.key().clone())
        .collect();

    for sibling in siblings {
        if let Some((_, ctx)) = room.peers.remove(&sibling) {
            // The FIRST cause wins: this peer's socket will send a Close frame moments from now
            // and recording that would report the consequence and hide the eviction.
            ctx.ledger.end(Disposition::SiblingEvicted);
            if let Err(e) = ctx.pc.close().await {
                warn!(
                    "[multi-device] failed to close sibling peer {}: {}",
                    sibling, e
                );
            } else {
                info!(
                    "[multi-device] evicted sibling peer {} for user {}",
                    sibling, user_id
                );
            }
        }
    }
}

async fn create_peer_connection() -> anyhow::Result<RTCPeerConnection> {
    let mut m = MediaEngine::default();
    m.register_default_codecs()?;

    let mut setting_engine = SettingEngine::default();
    // Relay-only SFU: mDNS/host candidates are useless and delay ICE pairing.
    setting_engine.set_ice_multicast_dns_mode(MulticastDnsMode::Disabled);

    let registry = Registry::new();
    let api = APIBuilder::new()
        .with_media_engine(m)
        .with_interceptor_registry(registry)
        .with_setting_engine(setting_engine)
        .build();

    let ice_servers = resolve_ice_servers().await;
    // Match browser clients (iceTransportPolicy: 'relay') so connectivity checks use TURN.
    let ice_transport_policy = if ice_servers.iter().any(|s| {
        s.urls
            .iter()
            .any(|u| u.contains("turn:") || u.contains("turns:"))
    }) {
        RTCIceTransportPolicy::Relay
    } else {
        RTCIceTransportPolicy::All
    };

    let config = RTCConfiguration {
        ice_servers,
        ice_transport_policy,
        ..Default::default()
    };

    Ok(api.new_peer_connection(config).await?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn room_secret_is_required() {
        assert!(require_room_secret(None).is_err());
        assert!(require_room_secret(Some(String::new())).is_err());
        assert!(require_room_secret(Some("   ".to_string())).is_err());
        let err = require_room_secret(None).unwrap_err().to_string();
        assert!(err.contains("CALL_ROOM_SECRET"));
        assert_eq!(
            require_room_secret(Some(" s3cret ".to_string())).unwrap(),
            "s3cret"
        );
    }

    fn ledger() -> CallLedger {
        CallLedger::new(
            "room-1".to_string(),
            "user-1:dev-a".to_string(),
            RoomMode::Sfu,
        )
    }

    /// The campaign greps these tokens out of the service log; they are a contract, not a
    /// wording choice, and changing one silently invalidates every row that read it.
    #[test]
    fn disposition_tokens_are_stable() {
        assert_eq!(Disposition::ClientClose.as_str(), "client-close");
        assert_eq!(Disposition::TransportError.as_str(), "transport-error");
        assert_eq!(Disposition::StreamEnded.as_str(), "stream-ended");
        assert_eq!(Disposition::RateLimited.as_str(), "rate-limited");
        assert_eq!(Disposition::SendFailed.as_str(), "send-failed");
        assert_eq!(Disposition::SiblingEvicted.as_str(), "sibling-evicted");
        assert_eq!(Disposition::RoomReaped.as_str(), "room-reaped");
    }

    /// Only a hangup and a deliberate multi-device replacement are endings the design intends.
    /// Everything else is a defect until shown otherwise, and is emitted at a level that says so.
    #[test]
    fn every_ending_the_design_did_not_intend_accuses() {
        assert!(Disposition::ClientClose.is_expected());
        assert!(Disposition::SiblingEvicted.is_expected());
        for d in [
            Disposition::TransportError,
            Disposition::StreamEnded,
            Disposition::RateLimited,
            Disposition::SendFailed,
            Disposition::RoomReaped,
        ] {
            assert!(!d.is_expected(), "{} must accuse", d.as_str());
        }
    }

    /// An evicted peer sends a Close frame moments later, and a reaped room's socket errors out
    /// afterwards. Keeping the last event would report the consequence and hide the cause.
    #[test]
    fn the_disposition_keeps_the_first_cause() {
        let l = ledger();
        assert!(l.end(Disposition::SiblingEvicted));
        assert!(!l.end(Disposition::ClientClose));
        assert_eq!(l.disposition(), Some(Disposition::SiblingEvicted));
    }

    #[test]
    fn a_connection_is_marked_once_so_a_flap_is_not_a_second_call() {
        let l = ledger();
        assert!(l.connected_ms().is_none());
        assert!(l.mark_connected().is_some());
        assert!(l.mark_connected().is_none());
        assert!(l.connected_ms().is_some());
    }

    /// `connected_ms=-` is not a missing value: it is the statement that media never flowed,
    /// and it is the field read first. Rendering it as a zero would make it unreadable.
    #[test]
    fn a_session_that_never_connected_says_so() {
        let l = ledger();
        l.end(Disposition::TransportError);
        let s = l.summary();
        assert!(s.contains("connected_ms=-"), "{}", s);
        assert!(s.contains("disposition=transport-error"), "{}", s);
        assert!(s.contains("ice_state=none"), "{}", s);
    }

    /// An unclassified ending is a hole in this file, not in the call, and must read as one
    /// rather than being silently defaulted to something plausible.
    #[test]
    fn an_unclassified_ending_reads_as_unknown() {
        assert!(ledger().summary().contains("disposition=unknown"));
    }

    /// The room id is also chat-delivery-service's `callId`: it is what joins the ring fan-out's
    /// half of the record to the SFU's half, and nothing else does.
    #[test]
    fn the_record_names_its_room_and_peer() {
        let s = ledger().summary();
        assert!(s.contains("room=room-1"), "{}", s);
        assert!(s.contains("peer=user-1:dev-a"), "{}", s);
    }

    #[test]
    fn the_counters_render_every_direction() {
        let l = ledger();
        bump(&l.offers_in);
        bump(&l.answers_out);
        bump(&l.offers_out);
        bump(&l.offers_out);
        bump(&l.answers_in);
        for _ in 0..4 {
            bump(&l.ice_in);
        }
        for _ in 0..3 {
            bump(&l.ice_in_buffered);
        }
        bump(&l.ice_in_failed);
        bump(&l.ice_in_failed);
        for _ in 0..5 {
            bump(&l.ice_out);
        }
        bump(&l.ice_out_failed);
        bump(&l.tracks_published);
        bump(&l.tracks_published);
        for _ in 0..3 {
            bump(&l.tracks_subscribed);
        }
        assert_eq!(
            l.counters(),
            concat!(
                "offer_in=1 answer_out=1 offer_out=2 answer_in=1 ",
                "ice_in=4 ice_buffered=3 ice_in_failed=2 ice_out=5 ice_out_failed=1 ",
                "tracks_pub=2 tracks_sub=3"
            )
        );
    }

    /// The line emitted when negotiation ends and the session record must never disagree about
    /// the ICE counts - one is built out of the other precisely so they cannot drift.
    #[test]
    fn the_terminal_ice_line_carries_the_same_figures_as_the_record() {
        let l = ledger();
        bump(&l.ice_in);
        bump(&l.ice_out);
        assert!(l.counters().contains(&l.ice_counters()));
    }

    #[test]
    fn the_record_reports_the_last_ice_state_seen() {
        let l = ledger();
        l.set_ice_state("Checking");
        l.set_ice_state("Failed");
        assert!(l.summary().contains("ice_state=Failed"));
    }

    /// In P2P the server never sees ICE, so the record must not print an ICE figure it cannot
    /// measure: it says `mode=p2p` and `paired_ms`, and `paired_ms=-` means nobody ever came.
    #[test]
    fn a_p2p_record_reports_pairing_and_no_ice_state() {
        let l = CallLedger::new("room-1".into(), "user-1:dev-a".into(), RoomMode::P2p);
        l.end(Disposition::ClientClose);
        let s = l.summary();
        assert!(s.contains("mode=p2p"), "{}", s);
        assert!(s.contains("paired_ms=-"), "{}", s);
        assert!(!s.contains("connected_ms"), "{}", s);
        assert!(!s.contains("ice_state"), "{}", s);
        l.mark_connected();
        assert!(!l.summary().contains("paired_ms=-"));
    }

    /// The wire spelling the client sends; an absent field is the original SFU design.
    #[test]
    fn join_reads_its_mode_and_defaults_to_sfu() {
        let p2p: SignalMessage =
            serde_json::from_str(r#"{"type":"Join","room_id":"r","room_token":"t","mode":"p2p"}"#)
                .unwrap();
        assert!(matches!(
            p2p,
            SignalMessage::Join {
                mode: RoomMode::P2p,
                ..
            }
        ));
        let legacy: SignalMessage =
            serde_json::from_str(r#"{"type":"Join","room_id":"r","room_token":"t"}"#).unwrap();
        assert!(matches!(
            legacy,
            SignalMessage::Join {
                mode: RoomMode::Sfu,
                ..
            }
        ));
        assert_eq!(
            serde_json::to_string(&SignalMessage::PeerLeft).unwrap(),
            r#"{"type":"PeerLeft"}"#
        );
    }
}
