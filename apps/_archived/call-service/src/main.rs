use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    response::IntoResponse,
    routing::get,
    Router,
};
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};
use tracing::{error, info};
use uuid::Uuid;
use webrtc::api::media_engine::MediaEngine;
use webrtc::api::APIBuilder;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::interceptor::registry::Registry;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::rtp_transceiver::rtp_codec::RTPCodecType;
use webrtc::track::track_local::track_local_static_rtp::TrackLocalStaticRTP;
use webrtc::track::track_local::{TrackLocal, TrackLocalWriter};
use webrtc::track::track_remote::TrackRemote;

// Global state for rooms
type RoomId = String;
type PeerId = String;

struct AppState {
    rooms: DashMap<RoomId, Arc<Room>>,
}

struct Room {
    // Store tracks to be added for new peers
    tracks: Mutex<Vec<Arc<TrackLocalStaticRTP>>>,
    // Store connected peers to notify/renegotiate
    peers: DashMap<PeerId, PeerContext>,
}

struct PeerContext {
    pc: Arc<RTCPeerConnection>,
    notify_tx: mpsc::Sender<SignalMessage>,
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(tag = "type")]
enum SignalMessage {
    Join { room_id: String },
    Offer { sdp: String },
    Answer { sdp: String },
    IceCandidate { candidate: String },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Initialize logging
    tracing_subscriber::fmt::init();

    let state = Arc::new(AppState {
        rooms: DashMap::new(),
    });

    let app = Router::new()
        .route("/ws", get(ws_handler))
        .with_state(state);

    let port = std::env::var("PORT").unwrap_or_else(|_| "3004".to_string());
    let addr = format!("0.0.0.0:{}", port);
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    info!("Call service listening on {}", addr);
    axum::serve(listener, app).await?;

    Ok(())
}

async fn ws_handler(ws: WebSocketUpgrade, State(state): State<Arc<AppState>>) -> impl IntoResponse {
    ws.on_upgrade(|socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: Arc<AppState>) {
    let peer_id = Uuid::new_v4().to_string();
    let mut current_room_id: Option<String> = None;

    // Channel to send signals from internal logic to WebSocket
    let (tx, mut rx) = mpsc::channel::<SignalMessage>(100);

    info!("New WebSocket connection: {}", peer_id);

    // Spawn a task to write to WebSocket
    let mut writer_socket = socket; // we will split later implicitly by usage ownership? No axum WS is unified stream.
                                    // Axum WebSocket is splitStream (SplitSink, SplitStream).
                                    // But here we own `socket`. We can't split easily without splitting the stream.
                                    // Let's loop with select!

    // Actually axum's WebSocket doesn't implement Clone, so we handle rx/tx loop.

    loop {
        tokio::select! {
            // Receive from WebSocket
            msg = writer_socket.recv() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                         match serde_json::from_str::<SignalMessage>(&text) {
                            Ok(signal) => {
                                handle_signal(&state, &peer_id, &mut current_room_id, signal, tx.clone()).await;
                            }
                            Err(e) => error!("JSON error: {}", e),
                        }
                    }
                    Some(Ok(Message::Close(_))) => break,
                    Some(Err(_)) => break,
                    None => break,
                    _ => {} // binary/ping/pong
                }
            }
            // Send to WebSocket (initiated by renegotiation)
            Some(msg) = rx.recv() => {
                let text = serde_json::to_string(&msg).unwrap();
                if let Err(e) = writer_socket.send(Message::Text(text)).await {
                    error!("WS send error: {}", e);
                    break;
                }
            }
        }
    }

    // Cleanup
    if let Some(room_id) = current_room_id {
        if let Some(room) = state.rooms.get(&room_id) {
            room.peers.remove(&peer_id); // PC is dropped, connection closed
                                         // Note: We might want to remove tracks owned by this peer from the room list so new joiners don't get dead tracks.
                                         // But simplifying for now.
            info!("Peer {} removed from room {}", peer_id, room_id);
        }
    }
}

async fn handle_signal(
    state: &Arc<AppState>,
    peer_id: &String,
    current_room_id: &mut Option<String>,
    signal: SignalMessage,
    notify_tx: mpsc::Sender<SignalMessage>,
) {
    match signal {
        SignalMessage::Join { room_id } => {
            info!("Peer {} joining room {}", peer_id, room_id);
            *current_room_id = Some(room_id.clone());

            let room = state
                .rooms
                .entry(room_id.clone())
                .or_insert_with(|| {
                    Arc::new(Room {
                        tracks: Mutex::new(Vec::new()),
                        peers: DashMap::new(),
                    })
                })
                .value()
                .clone();

            // Create PC
            let pc = create_peer_connection().await.unwrap();

            // Add existing tracks to this new PC
            let tracks = room.tracks.lock().await;
            for track in tracks.iter() {
                pc.add_track(Arc::clone(track) as Arc<dyn TrackLocal + Send + Sync>)
                    .await
                    .unwrap();
                // Spawn PLI requester for video
                if track.kind() == RTPCodecType::Video {
                    tokio::spawn(async move {
                        // Simple PLI loop? Or handled by interceptor?
                        // Webrtc-rs creates interceptors by default.
                    });
                }
            }
            drop(tracks);

            // On Ice Candidate -> Send to Client
            let notify_tx_clone = notify_tx.clone();
            pc.on_ice_candidate(Box::new(move |c| {
                let notify_tx_clone = notify_tx_clone.clone();
                Box::pin(async move {
                    if let Some(c) = c {
                        if let Ok(json) = c.to_json() {
                            let msg = SignalMessage::IceCandidate {
                                candidate: serde_json::to_string(&json).unwrap(),
                            };
                            let _ = notify_tx_clone.send(msg).await;
                        }
                    }
                })
            }));

            // On Track -> Add to Room and Renegotiate others
            let room_clone = room.clone();
            let peer_id_clone = peer_id.clone();
            pc.on_track(Box::new(
                move |track: Arc<TrackRemote>, _receiver, _transceiver| {
                    let room_clone = room_clone.clone();
                    let peer_id_clone = peer_id_clone.clone();

                    Box::pin(async move {
                        let remote_track = track;
                        info!(
                            "Track received from {}: kind={}",
                            peer_id_clone,
                            remote_track.kind()
                        );

                        // Create a LocalTrack to forward this RemoteTrack
                        let local_track = Arc::new(TrackLocalStaticRTP::new(
                            remote_track.codec().capability.clone(),
                            format!("track-{}", Uuid::new_v4()),
                            "webrtc-rs".to_owned(),
                        ));

                        // Store in room
                        {
                            let mut room_tracks = room_clone.tracks.lock().await;
                            room_tracks.push(local_track.clone());
                        }

                        // Forward RTP packets
                        let local_track_clone = local_track.clone();
                        tokio::spawn(async move {
                            let mut buf = vec![0u8; 1500];
                            while let Ok((parsed, _)) = remote_track.read(&mut buf).await {
                                if let Err(_e) = local_track_clone.write_rtp(&parsed).await {
                                    // error sending
                                }
                            }
                        });

                        // Add this new local_track to ALL OTHER peers in the room
                        for peer_entry in room_clone.peers.iter() {
                            let other_pid = peer_entry.key();
                            if other_pid == &peer_id_clone {
                                continue;
                            }

                            let other_ctx = peer_entry.value();
                            if let Err(e) = other_ctx
                                .pc
                                .add_track(
                                    Arc::clone(&local_track) as Arc<dyn TrackLocal + Send + Sync>
                                )
                                .await
                            {
                                error!("Failed to add track to peer {}: {}", other_pid, e);
                                continue;
                            }

                            // Renegotiate with other peer
                            // Create Offer
                            if let Ok(offer) = other_ctx.pc.create_offer(None).await {
                                if other_ctx
                                    .pc
                                    .set_local_description(offer.clone())
                                    .await
                                    .is_ok()
                                {
                                    let _ = other_ctx
                                        .notify_tx
                                        .send(SignalMessage::Offer {
                                            sdp: serde_json::to_string(&offer).unwrap(),
                                        })
                                        .await;
                                }
                            }
                        }
                    })
                },
            ));

            // Store peer in room
            room.peers.insert(
                peer_id.clone(),
                PeerContext {
                    pc: Arc::new(pc),
                    notify_tx,
                },
            );
        }
        SignalMessage::Offer { sdp } => {
            if let Some(room_id) = current_room_id {
                if let Some(room) = state.rooms.get(room_id) {
                    if let Some(ctx) = room.peers.get(peer_id) {
                        // Deserialize SDP
                        if let Ok(sdp_obj) = serde_json::from_str::<RTCSessionDescription>(&sdp) {
                            if let Err(e) = ctx.pc.set_remote_description(sdp_obj).await {
                                error!("Set remote desc error: {}", e);
                                return;
                            }

                            // Answer
                            match ctx.pc.create_answer(None).await {
                                Ok(answer) => {
                                    if ctx.pc.set_local_description(answer.clone()).await.is_ok() {
                                        let _ = ctx
                                            .notify_tx
                                            .send(SignalMessage::Answer {
                                                sdp: serde_json::to_string(&answer).unwrap(),
                                            })
                                            .await;
                                    }
                                }
                                Err(e) => error!("Create answer error: {}", e),
                            }
                        }
                    }
                }
            }
        }
        SignalMessage::Answer { sdp } => {
            // Handle Answer (renegotiation response)
            if let Some(room_id) = current_room_id {
                if let Some(room) = state.rooms.get(room_id) {
                    if let Some(ctx) = room.peers.get(peer_id) {
                        if let Ok(sdp_obj) = serde_json::from_str::<RTCSessionDescription>(&sdp) {
                            let _ = ctx.pc.set_remote_description(sdp_obj).await;
                        }
                    }
                }
            }
        }
        SignalMessage::IceCandidate { candidate } => {
            if let Some(room_id) = current_room_id {
                if let Some(room) = state.rooms.get(room_id) {
                    if let Some(ctx) = room.peers.get(peer_id) {
                        // Candidate is JSON string
                        if let Ok(cand) = serde_json::from_str::<
                            webrtc::ice_transport::ice_candidate::RTCIceCandidateInit,
                        >(&candidate)
                        {
                            let _ = ctx.pc.add_ice_candidate(cand).await;
                        }
                    }
                }
            }
        }
    }
}

async fn create_peer_connection() -> anyhow::Result<RTCPeerConnection> {
    let mut m = MediaEngine::default();
    m.register_default_codecs()?;

    let registry = Registry::new();
    let api = APIBuilder::new()
        .with_media_engine(m)
        .with_interceptor_registry(registry)
        .build();

    let config = RTCConfiguration {
        ice_servers: vec![RTCIceServer {
            urls: vec!["stun:stun.l.google.com:19302".to_owned()],
            ..Default::default()
        }],
        ..Default::default()
    };

    Ok(api.new_peer_connection(config).await?)
}
