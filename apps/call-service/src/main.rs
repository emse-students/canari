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
use dashmap::DashMap;
use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};
use tracing::{error, info, warn};
use uuid::Uuid;
use webrtc::api::media_engine::MediaEngine;
use webrtc::api::APIBuilder;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::interceptor::registry::Registry;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::policy::ice_transport_policy::RTCIceTransportPolicy;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::rtp_transceiver::rtp_codec::RTPCodecType;
use webrtc::track::track_local::track_local_static_rtp::TrackLocalStaticRTP;
use webrtc::track::track_local::{TrackLocal, TrackLocalWriter};
use webrtc::track::track_remote::TrackRemote;

type RoomId = String;
type PeerId = String;

/// JWT payload (`sub` = user id).
#[derive(Serialize, Deserialize)]
struct Claims {
    sub: String,
    exp: usize,
}

#[derive(Deserialize)]
struct AuthParams {
    token: Option<String>,
}

struct AppState {
    rooms: DashMap<RoomId, Arc<Room>>,
    jwt_secret: String,
}

struct Room {
    tracks: Mutex<Vec<Arc<TrackLocalStaticRTP>>>,
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
    tracing_subscriber::fmt::init();

    let jwt_secret = std::env::var("JWT_SECRET").unwrap_or_else(|_| {
        warn!("JWT_SECRET not set — WebSocket auth will reject all connections");
        String::new()
    });

    let state = Arc::new(AppState {
        rooms: DashMap::new(),
        jwt_secret,
    });

    let app = Router::new()
        .route("/ws", get(ws_handler))
        .route("/api/health", get(health_handler))
        .with_state(state);

    let port = std::env::var("PORT").unwrap_or_else(|_| "3004".to_string());
    let addr = format!("0.0.0.0:{}", port);
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    info!("Call service listening on {}", addr);
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

    let token = extract_cookie_value(&headers, "canari_ws_token").or(params.token);
    let Some(token) = token else {
        return (StatusCode::UNAUTHORIZED, "Missing auth token").into_response();
    };

    let validation = Validation::new(Algorithm::HS256);
    let key = DecodingKey::from_secret(state.jwt_secret.as_bytes());

    match decode::<Claims>(&token, &key, &validation) {
        Ok(token_data) => {
            let user_id = token_data.claims.sub;
            info!("Authenticated WebSocket upgrade for user {}", user_id);
            ws.on_upgrade(move |socket| handle_socket(socket, state, user_id))
        }
        Err(e) => {
            error!("JWT validation failed: {}", e);
            (StatusCode::UNAUTHORIZED, "Invalid token").into_response()
        }
    }
}

async fn handle_socket(socket: WebSocket, state: Arc<AppState>, user_id: String) {
    let peer_id = format!("{}:{}", user_id, Uuid::new_v4());
    let mut current_room_id: Option<String> = None;

    let (tx, mut rx) = mpsc::channel::<SignalMessage>(100);

    info!("New WebSocket connection: {}", peer_id);

    let mut writer_socket = socket;

    loop {
        tokio::select! {
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
                    _ => {}
                }
            }
            Some(msg) = rx.recv() => {
                let text = serde_json::to_string(&msg).unwrap();
                if let Err(e) = writer_socket.send(Message::Text(text)).await {
                    error!("WS send error: {}", e);
                    break;
                }
            }
        }
    }

    if let Some(room_id) = current_room_id {
        if let Some(room) = state.rooms.get(&room_id) {
            room.peers.remove(&peer_id);
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

            let pc = match create_peer_connection().await {
                Ok(pc) => pc,
                Err(e) => {
                    error!("Failed to create peer connection: {}", e);
                    return;
                }
            };

            let tracks = room.tracks.lock().await;
            for track in tracks.iter() {
                if let Err(e) = pc
                    .add_track(Arc::clone(track) as Arc<dyn TrackLocal + Send + Sync>)
                    .await
                {
                    error!("Failed to add existing track: {}", e);
                }
                if track.kind() == RTPCodecType::Video {
                    tokio::spawn(async move {});
                }
            }
            drop(tracks);

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

                        let local_track = Arc::new(TrackLocalStaticRTP::new(
                            remote_track.codec().capability.clone(),
                            format!("track-{}-{}", peer_id_clone, Uuid::new_v4()),
                            "canari-sfu".to_owned(),
                        ));

                        {
                            let mut room_tracks = room_clone.tracks.lock().await;
                            room_tracks.push(local_track.clone());
                        }

                        let local_track_clone = local_track.clone();
                        tokio::spawn(async move {
                            let mut buf = vec![0u8; 1500];
                            while let Ok((parsed, _)) = remote_track.read(&mut buf).await {
                                if local_track_clone.write_rtp(&parsed).await.is_err() {
                                    break;
                                }
                            }
                        });

                        for peer_entry in room_clone.peers.iter() {
                            let other_pid = peer_entry.key();
                            if other_pid == &peer_id_clone {
                                continue;
                            }

                            let other_ctx = peer_entry.value();
                            if let Err(e) = other_ctx
                                .pc
                                .add_track(
                                    Arc::clone(&local_track) as Arc<dyn TrackLocal + Send + Sync>,
                                )
                                .await
                            {
                                error!("Failed to add track to peer {}: {}", other_pid, e);
                                continue;
                            }

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
                        if let Ok(sdp_obj) = serde_json::from_str::<RTCSessionDescription>(&sdp) {
                            if let Err(e) = ctx.pc.set_remote_description(sdp_obj).await {
                                error!("Set remote desc error: {}", e);
                                return;
                            }

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

/// Mint short-lived TURN credentials from Cloudflare (same API as chat-delivery clients).
async fn fetch_cloudflare_ice_servers() -> Option<Vec<RTCIceServer>> {
    let api_token = std::env::var("CLOUDFLARE_CALLS_API_TOKEN")
        .ok()
        .filter(|s| !s.trim().is_empty())?;
    let turn_key_id = std::env::var("CLOUDFLARE_TURN_KEY_ID")
        .ok()
        .filter(|s| !s.trim().is_empty())?;

    let ttl: u64 = std::env::var("CLOUDFLARE_TURN_TTL_SECONDS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(7200);

    let url = format!(
        "https://rtc.live.cloudflare.com/v1/turn/keys/{}/credentials/generate-ice-servers",
        turn_key_id
    );

    let client = reqwest::Client::new();
    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", api_token))
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({ "ttl": ttl }))
        .send()
        .await
        .ok()?;

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

    let data: CloudflareIceResponse = response.json().await.ok()?;
    let servers: Vec<RTCIceServer> = data
        .ice_servers
        .into_iter()
        .filter_map(|entry| {
            let urls: Vec<String> = match &entry.urls {
                serde_json::Value::String(u) => vec![u.clone()],
                serde_json::Value::Array(arr) => arr
                    .iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .filter(|u| !u.contains(":53"))
                    .collect(),
                _ => return None,
            };
            if urls.is_empty() {
                return None;
            }
            Some(RTCIceServer {
                urls,
                username: entry.username.unwrap_or_default(),
                credential: entry.credential.unwrap_or_default(),
                ..Default::default()
            })
        })
        .collect();

    if servers.is_empty() {
        error!("[ICE] Cloudflare returned no usable ICE servers for SFU");
        return None;
    }

    info!("[ICE] SFU using {} Cloudflare TURN server(s)", servers.len());
    Some(servers)
}

/// Static TURN from env when Cloudflare is not configured (dev only).
fn ice_servers_from_env() -> Vec<RTCIceServer> {
    let turn_url = std::env::var("TURN_URL").ok();
    let turn_user = std::env::var("TURN_USERNAME").unwrap_or_else(|_| "user".to_string());
    let turn_cred = std::env::var("TURN_CREDENTIAL").unwrap_or_else(|_| "password".to_string());

    if let Some(urls_raw) = turn_url.filter(|s| !s.trim().is_empty()) {
        let urls: Vec<String> = urls_raw
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        if !urls.is_empty() {
            info!("SFU using TURN_URL env ({} URL(s))", urls.len());
            return vec![RTCIceServer {
                urls,
                username: turn_user,
                credential: turn_cred,
                ..Default::default()
            }];
        }
    }

    warn!("SFU has no Cloudflare/TURN config — STUN only; relay-only clients may not connect");
    vec![RTCIceServer {
        urls: vec!["stun:stun.l.google.com:19302".to_owned()],
        ..Default::default()
    }]
}

async fn resolve_ice_servers() -> Vec<RTCIceServer> {
    if let Some(servers) = fetch_cloudflare_ice_servers().await {
        return servers;
    }
    ice_servers_from_env()
}

async fn create_peer_connection() -> anyhow::Result<RTCPeerConnection> {
    let mut m = MediaEngine::default();
    m.register_default_codecs()?;

    let registry = Registry::new();
    let api = APIBuilder::new()
        .with_media_engine(m)
        .with_interceptor_registry(registry)
        .build();

    let ice_servers = resolve_ice_servers().await;
    // Match browser clients (iceTransportPolicy: 'relay') so connectivity checks use TURN.
    let ice_transport_policy = if ice_servers.iter().any(|s| {
        s.urls.iter().any(|u| u.contains("turn:") || u.contains("turns:"))
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
