use axum::{
    extract::{
        Query, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use futures::{sink::SinkExt, stream::StreamExt};
use std::sync::{
    Arc,
    atomic::{AtomicU32, Ordering},
};
use tokio::sync::mpsc;

use crate::models::{AuthParams, TokenRejection, decode_access_claims};
use crate::state::{AdmissionRefusal, AppState};

/// Heartbeat cadence: one WebSocket ping every this many seconds.
const PING_INTERVAL_SECS: u64 = 15;
/// A client is declared dead once more than this many pings are outstanding.
const MAX_MISSED_PONGS: u32 = 4;
/// Worst-case time before a dead-but-open socket is closed by the heartbeat.
const DEAD_SOCKET_DETECTION_SECS: u64 = PING_INTERVAL_SECS * (MAX_MISSED_PONGS as u64 + 1);
/// TTL of the `user:online:{userId}:{deviceId}` key. It MUST outlive the detection window: a
/// shorter TTL made the key vanish while the socket still looked connected ("WS connected, Redis
/// empty" for ~55 s on the admin presence screen, prod 2026-10-05).
pub const PRESENCE_TTL_SECS: u64 = 90;
const _: () = assert!(PRESENCE_TTL_SECS > DEAD_SOCKET_DETECTION_SECS);
use crate::ws_dispatch::{
    WsConn, WsFrame, handle_disconnect, handle_retired_frame, handle_typing, is_ephemeral_frame,
    is_retired_frame,
};

// ── How a socket ENDED ───────────────────────────────────────────────

/// What an error ending the receive loop MEANS, which is the only thing that can decide the level
/// of the line recording it.
#[derive(Debug, PartialEq, Eq)]
enum SocketEnd {
    /// The ordinary end of a web session. A browser that reloads, navigates away or is killed
    /// sends no close frame, so the socket simply resets - the impolite twin of `Message::Close`,
    /// and recorded beside it at the same level so the two can be counted as one event.
    Goodbye,
    /// Anything else. Deliberately everything else: the predicate is exactly as wide as the
    /// measurement below and not one variant wider, so a family nobody has seen arrives as the
    /// only ERROR line on the box rather than hiding inside a name that was widened to fit it.
    Fault,
    /// The error under axum's is not a `tungstenite::Error` at all, so nothing here could read it.
    /// **This is a SIGNAL, never a path** - it can only happen if a future axum bump stops
    /// unifying with this crate's direct `tokio-tungstenite` dependency, at which point every
    /// goodbye silently becomes a fault again. It is therefore logged at a level that ACCUSES and
    /// names its own cause.
    Unreadable,
}

/// Decide whether a receive-loop error is the ordinary end of a web session or a real fault.
///
/// **THE FIX IS A CLASSIFICATION, NOT A DEMOTION.** `axum` boxes the `tungstenite::Error` exactly
/// once, so `source()` hands back the real type and `ResetWithoutClosingHandshake` is a VARIANT
/// rather than prose - which is the only reason this is allowed to change a level at all.
///
/// MEASURED ON PRODUCTION 2026-09-15, over 7 days of `infrastructure-chat-gateway-1`: **32 of 32**
/// ERROR lines were this one family, across 10 distinct users, out of 2680 lines total. The polite
/// version of the same event - `Message::Close` - fired 3 times. So the gateway's ERROR channel
/// carried exactly one thing and that thing was people closing tabs: a genuine fault would have
/// been one line among 33, and nobody would have looked. That measurement is the argument; the
/// line count on a developer estate is not, and was explicitly not trusted for this.
fn classify_socket_error(err: &axum::Error) -> SocketEnd {
    use std::error::Error as _;
    use tokio_tungstenite::tungstenite::{Error as WsError, error::ProtocolError};

    let Some(ws) = err.source().and_then(|s| s.downcast_ref::<WsError>()) else {
        return SocketEnd::Unreadable;
    };
    match ws {
        WsError::Protocol(ProtocolError::ResetWithoutClosingHandshake) => SocketEnd::Goodbye,
        _ => SocketEnd::Fault,
    }
}

// ── Cookie helper ─────────────────────────────────────────────────────────

/// Extract the value of a named cookie from the `Cookie` HTTP header.
/// Returns `None` if the header is absent or the named cookie is not present.
fn extract_cookie_value(headers: &HeaderMap, key: &str) -> Option<String> {
    let cookie_header = headers.get("cookie")?.to_str().ok()?;
    for part in cookie_header.split(';') {
        let trimmed = part.trim();
        if let Some((name, value)) = trimmed.split_once('=')
            && name.trim() == key
        {
            return Some(value.trim().to_string());
        }
    }
    None
}

// ── ConnectionGuard - cleanup on drop ────────────────────────────────────

/// RAII guard that cleans up a WebSocket connection's in-memory entry and
/// Redis presence key when the connection task exits (for any reason).
///
/// Using `Drop` instead of explicit cleanup ensures presence is removed even
/// when the task is cancelled or panics.
struct ConnectionGuard {
    state: Arc<AppState>,
    /// The `"userId:deviceId"` key used in `connected_users`.
    conn_key: String,
    /// This session's field in the device's sessions hash ([`crate::addressing`]), removed on
    /// every exit - whether or not another session keeps the device online.
    field: String,
    /// Unique ID assigned to this connection, used for O(1) removal from the map.
    conn_id: u64,
}

impl Drop for ConnectionGuard {
    fn drop(&mut self) {
        // Remove this specific connection by its unique ID, then check whether
        // any other live sessions remain for the same conn_key (e.g. other tabs
        // or a fast reconnect).  `AppState::remove_session` owns that decision so
        // the explicit-disconnect path asks exactly the same question.
        let still_connected = self.state.remove_session(&self.conn_key, self.conn_id);

        // The presence itself is decided by the shared hash inside the script (crate::addressing):
        // it goes when no session of the device is left on ANY process. `still_connected` is this
        // process's view only, logged for the reader.
        tracing::info!(
            "[presence] Retiring session {} of {} (another local session: {})",
            self.field,
            self.conn_key,
            still_connected
        );
        let state = self.state.clone();
        let field = self.field.clone();
        let conn_key = self.conn_key.clone();
        // Retry up to 3 times so a brief Redis blip doesn't leave a stale key. A field left behind
        // anyway expires with its own TTL; until then an undeclared one only keeps the device
        // unaddressable (crate::addressing), never the reverse.
        tokio::spawn(async move {
            for attempt in 0u8..3 {
                if attempt > 0 {
                    tokio::time::sleep(tokio::time::Duration::from_millis(300)).await;
                }
                match state.redis_client.get_multiplexed_async_connection().await {
                    Ok(mut con) => {
                        match crate::addressing::leave_session(
                            &mut con,
                            &conn_key,
                            Some(&field),
                            PRESENCE_TTL_SECS,
                        )
                        .await
                        {
                            Ok(()) => {
                                tracing::info!(
                                    "[presence] Session {} of {} retired (attempt {})",
                                    field,
                                    conn_key,
                                    attempt + 1
                                );
                                return;
                            }
                            Err(e) => tracing::warn!(
                                "[presence] Leaving session {} of {} failed (attempt {}): {}",
                                field,
                                conn_key,
                                attempt + 1,
                                e
                            ),
                        }
                    }
                    Err(e) => {
                        tracing::warn!(
                            "[presence] Redis unavailable to leave session {} of {} (attempt {}): {}",
                            field,
                            conn_key,
                            attempt + 1,
                            e
                        );
                    }
                }
            }
            tracing::warn!(
                "[presence] Leaving session {} of {} abandoned after 3 attempts",
                field,
                conn_key
            );
        });
    }
}

// ── The origin of an upgrade ──────────────────────────────────────────────

/// Longest origin written to a log line; a real one is a few dozen bytes.
const LOGGED_ORIGIN_MAX: usize = 120;

/// Refuse, with a 403, an upgrade whose `Origin` this estate does not serve its clients from
/// (`AppState::upgrade_origins`); a request with no `Origin` passes.
///
/// THE REFUSED ORIGIN IS LOGGED, once per distinct value and then at each power of ten: it is the
/// one fact that identifies a client turned away, and it appears nowhere else on either side. It is
/// text its sender chose, so it is written escaped and cut.
fn admit_origin(state: &AppState, headers: &HeaderMap) -> Result<(), Box<Response>> {
    let origin = match headers.get(axum::http::header::ORIGIN) {
        None => None,
        // A header that is not text names no origin this estate could have listed.
        Some(value) => Some(value.to_str().unwrap_or("")),
    };
    let Err(refusal) = state.upgrade_origins.admits(origin) else {
        return Ok(());
    };
    let shown: String = origin
        .unwrap_or("")
        .chars()
        .take(LOGGED_ORIGIN_MAX)
        .collect();
    if let Some(n) = state.refused_origins.hit(&shown) {
        match refusal {
            crate::origin::OriginRefusal::NotListed => tracing::warn!(
                "[ws] upgrade REFUSED: origin {:?} is not in ALLOW_ORIGIN - refusal #{} for this origin",
                shown,
                n
            ),
            crate::origin::OriginRefusal::NoList => tracing::error!(
                "[ws] upgrade REFUSED: origin {:?} cannot be matched, ALLOW_ORIGIN is '*' and that is not a list - refusal #{} for this origin",
                shown,
                n
            ),
        }
    }
    Err(Box::new(
        (StatusCode::FORBIDDEN, "Origin not allowed").into_response(),
    ))
}

// ── Public WS upgrade handler ─────────────────────────────────────────────

/// Axum handler for `GET /api/ws`.
///
/// Validates the JWT from the `canari_ws_token` cookie.
/// Falls back to the `?token=` query parameter for Tauri Android/mobile where
/// the native WebSocket plugin cannot forward WebView cookies.
/// Returns `401 Unauthorized` if no valid token is found, and `403 Forbidden` before that when the
/// request names an `Origin` that is not an allowed one.
pub async fn ws_handler(
    ws: WebSocketUpgrade,
    Query(params): Query<AuthParams>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> Response {
    // THE PAGE IS ASKED FIRST: an upgrade that names an origin this estate does not serve its
    // clients from is refused before its token is read (`crate::origin`).
    if let Err(refusal) = admit_origin(&state, &headers) {
        return *refusal;
    }

    // Cookie is preferred (web browser) - query-param is the Tauri mobile fallback.
    let token = extract_cookie_value(&headers, "canari_ws_token").or_else(|| {
        params.token.as_deref().map(|t| {
            tracing::debug!(
                "[ws] Using ?token= fallback (Tauri mobile), prefix={}…",
                t.chars().take(8).collect::<String>()
            );
            t.to_string()
        })
    });

    let Some(token) = token else {
        return (StatusCode::UNAUTHORIZED, "Missing auth token").into_response();
    };

    match decode_access_claims(&token, state.jwt_secret.as_bytes()) {
        Ok(claims) => {
            // Use the device_id provided by the client to keep the same routing key
            // across reconnections (otherwise group:members becomes stale).
            // Security relies on the JWT: only the userId from the token can access messages.
            fn is_valid_device_id(id: &str) -> bool {
                !id.is_empty()
                    && id.len() <= 256
                    && id
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
            }
            let device_id = params
                .device_id
                .as_deref()
                .filter(|id| {
                    let valid = is_valid_device_id(id);
                    if !valid && !id.is_empty() {
                        tracing::warn!(
                            "[ws] device_id contains invalid characters, generating UUID instead"
                        );
                    }
                    valid
                })
                .map(|id| id.to_string())
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

            // What the code behind this socket declared (history-answer-addressing, rule 6).
            let declared = crate::addressing::SessionCaps::from_query(params.caps.as_deref());
            // What the build behind it says it is: counted, never attached to an identity
            // (crate::census).
            let client = crate::census::ClientKind::from_query(
                params.platform.as_deref(),
                params.app_version.as_deref(),
            );
            // THE PLACE IS TAKEN BEFORE THE UPGRADE (`AppState::admit`): counted and registered
            // under the map lock, per account and for the process. A request past either limit is
            // answered 503 and never upgraded, so the client's socket FAILS before it opens and
            // its reconnection delay climbs; a socket opened and then closed would reset that
            // delay on every attempt.
            let conn_key = format!("{}:{}", claims.sub, device_id);
            // A unique monotonic id, so the guard removes exactly this connection from the map.
            let conn_id = state.next_conn_id.fetch_add(1, Ordering::Relaxed);
            let (tx, rx) = mpsc::channel::<String>(256);
            match state.admit(&claims.sub, &conn_key, conn_id, tx.clone(), declared) {
                Ok(active) => tracing::info!(
                    "Registered connection key: {} (conn_id={}, {} active)",
                    conn_key,
                    conn_id,
                    active
                ),
                Err(refusal) => return refuse_admission(&state, &claims.sub, &refusal),
            }
            // The guard travels INSIDE the upgrade callback: an upgrade that never completes drops
            // the callback unrun, and the place with it.
            let admitted = Admitted {
                guard: ConnectionGuard {
                    state: state.clone(),
                    field: crate::addressing::session_field(&state.instance_id, conn_id),
                    conn_key,
                    conn_id,
                },
                tx,
                rx,
            };
            ws.on_upgrade(move |socket| {
                handle_socket(
                    socket, state, claims.sub, device_id, declared, client, admitted,
                )
            })
        }
        Err(TokenRejection::NotAnAccessToken(kind)) => {
            tracing::warn!(
                "[ws] upgrade refused: a '{}' token is not an access token",
                kind
            );
            (StatusCode::UNAUTHORIZED, "Invalid parameters").into_response()
        }
        Err(TokenRejection::Invalid(e)) => {
            tracing::debug!("[ws] upgrade refused: {}", e);
            (StatusCode::UNAUTHORIZED, "Invalid parameters").into_response()
        }
    }
}

/// A socket's place on this process, held from before its upgrade until its task ends.
struct Admitted {
    /// Frees the place when dropped, whether the socket ran or was never upgraded.
    guard: ConnectionGuard,
    /// The sender registered in `AppState::connected_users`.
    tx: mpsc::Sender<String>,
    /// Its receiver; a frame published between admission and upgrade waits here.
    rx: mpsc::Receiver<String>,
}

/// Answer a request `AppState::admit` refused: 503, before any upgrade.
///
/// Logged once per subject and episode, then at each power of ten (`AppState::note_refusal`): a
/// client that keeps asking is a RATE, and the count is what says so.
fn refuse_admission(state: &AppState, user_id: &str, refusal: &AdmissionRefusal) -> Response {
    if let Some(n) = state.note_refusal(user_id, refusal) {
        tracing::warn!(
            "[ws] socket REFUSED for {} ({:?}; limits {} per account, {} in all) - refusal #{} of this episode",
            user_id,
            refusal,
            state.max_connections_per_account,
            state.max_connections,
            n
        );
    }
    (StatusCode::SERVICE_UNAVAILABLE, "Too many connections").into_response()
}

// ── Socket lifecycle ──────────────────────────────────────────────────────

/// Drive a single authenticated WebSocket connection.
///
/// Responsibilities:
/// - Receives its place already taken (`Admitted`, registered by `ws_handler` before the upgrade).
/// - Sets (and periodically refreshes) the `user:online:{userId}:{deviceId}` Redis key.
/// - Drains `pending_welcome_notify:{userId}` - welcome_request signals stored while
///   all group members were offline - and forwards them so this device can handle them.
/// - Spawns two concurrent tasks: a **send task** (outbound frames + ping heartbeat) and
///   a **recv task** (inbound frame dispatch).
/// - Uses `ConnectionGuard` to ensure cleanup happens even on task cancellation.
#[allow(clippy::collapsible_if)]
async fn handle_socket(
    socket: WebSocket,
    state: Arc<AppState>,
    user_id: String,
    device_id: String,
    declared: crate::addressing::SessionCaps,
    client: crate::census::ClientKind,
    admitted: Admitted,
) {
    tracing::info!(
        "New WebSocket connection: User={}, Device={}, addressed_history={}, join_ask={}, platform={}, version={}",
        user_id,
        device_id,
        declared.addressed_history,
        declared.join_ask,
        client.platform,
        client.version
    );

    // The guard lives as long as this task: cleanup happens on every exit.
    let Admitted {
        guard: _guard,
        tx,
        mut rx,
    } = admitted;
    let conn_key = _guard.conn_key.clone();
    let conn_id = _guard.conn_id;
    let field = _guard.field.clone();

    // THE DUPLICATE-CONNECTION RULE: A NEW SOCKET FOR A DEVICE IS ADDED BESIDE ITS SIBLINGS, NEVER
    // REPLACES OR REFUSES THEM. Several sessions of one device id are legitimate - two tabs of one
    // browser share it (a leadership hand-over overlaps them), a reconnect overlaps its
    // predecessor's close, a deploy overlap spreads them over two processes - and each is a field of the shared sessions hash (crate::addressing), so
    // this process could not see, let alone close, a sibling held by another. Replacing would also
    // turn two live tabs into a reconnect duel. What this rule costs: a socket its client forgot
    // keeps answering pings and keeps the device online, so the CLIENT owns releasing every socket
    // it opened (`BaseMlsService.destroy`, docs/wiki/frontend/modules/auth.md). The count is
    // the reading that shows one, taken at admission (`ws_handler`).
    let (mut ws_sender, mut receiver) = socket.split();

    // Consecutive-pings-without-Pong counter. Incremented on each ping tick,
    // reset to zero as soon as a frame (Pong or Text) proves the client is responsive.
    // The client is only declared dead after MAX_MISSED_PONGS consecutive unanswered
    // pings - a tolerance, not a guillotine on a single late pong (1s+ network jitter
    // is common on wifi/mobile and must not tear down the connection).
    let awaiting_pong = Arc::new(AtomicU32::new(0));

    // Establish ONE shared Redis connection for this socket's lifetime.
    // MultiplexedConnection is Clone - all clones share the same underlying
    // TCP connection, so we avoid opening a new connection for every frame.
    // If Redis is unavailable at connect time, we proceed in degraded mode
    // (no presence) and attempt to reconnect on the first Pong / frame.
    let redis_conn: Option<redis::aio::MultiplexedConnection> = match state
        .redis_client
        .get_multiplexed_async_connection()
        .await
    {
        Ok(mut con) => {
            // ── Set initial presence key ───────────────────────────────
            // With this session's declaration in the device's sessions hash (crate::addressing);
            // presence itself is the key's existence.
            if let Err(e) = crate::addressing::write_session(
                &mut con,
                &conn_key,
                &field,
                declared,
                PRESENCE_TTL_SECS,
            )
            .await
            {
                tracing::warn!(
                    "[presence] presence write on connect failed for {}: {}",
                    conn_key,
                    e
                );
            } else {
                tracing::info!(
                    "[presence] Online: {} (TTL={}s)",
                    conn_key,
                    PRESENCE_TTL_SECS
                );
            }
            note_client(&mut con, &conn_key, &client).await;

            // ── Drain pending welcome_request signals ─────────────────
            // When no peer was online for a welcome_request, the delivery service
            // stores the signal in pending_welcome_notify:{userId} for each group member.
            // The first member to reconnect receives these signals and can trigger the
            // missing Welcomes.
            let notify_key = format!("pending_welcome_notify:{}", user_id);
            match redis::cmd("LRANGE")
                .arg(&notify_key)
                .arg(0)
                .arg(-1)
                .query_async::<Vec<String>>(&mut con)
                .await
            {
                Ok(msgs) if !msgs.is_empty() => {
                    tracing::info!(
                        "[pending_welcome] Draining {} welcome_request(s) for {}",
                        msgs.len(),
                        user_id
                    );
                    let mut send_ok = true;
                    for msg in &msgs {
                        if ws_sender
                            .send(Message::Text(msg.clone().into()))
                            .await
                            .is_err()
                        {
                            send_ok = false;
                            break;
                        }
                    }
                    // Delete the key even on partial failure: the delivery service
                    // will resend via FCM if the welcome_request is still pending.
                    if send_ok {
                        if let Err(e) = redis::cmd("DEL")
                            .arg(&notify_key)
                            .query_async::<()>(&mut con)
                            .await
                        {
                            tracing::warn!("[pending_welcome] DEL {} failed: {}", notify_key, e);
                        }
                    }
                }
                Err(e) => {
                    tracing::warn!("[pending_welcome] LRANGE {} failed: {}", notify_key, e)
                }
                _ => {}
            }

            Some(con)
        }
        Err(e) => {
            tracing::warn!(
                "[presence] Redis unavailable at connect for {} - proceeding in degraded mode: {}",
                conn_key,
                e
            );
            None
        }
    };

    // ── Send task: relay outbound frames + heartbeat ping ────────────────
    // Ping every PING_INTERVAL_SECS. The client is declared dead after
    // MAX_MISSED_PONGS consecutive unanswered pings (detection window
    // ~PING_INTERVAL_SECS * MAX_MISSED_PONGS), deliberately under the nginx
    // proxy_read_timeout (120s) so that pings keep the tunnel alive.
    // Essential tolerance: a single late pong (network jitter) must not
    // close the connection (cause of repeated 1006 disconnections).
    let conn_key_ping = conn_key.clone();
    let pong_flag_send = awaiting_pong.clone();
    let mut send_task = tokio::spawn(async move {
        let mut ping_interval =
            tokio::time::interval(std::time::Duration::from_secs(PING_INTERVAL_SECS));
        ping_interval.tick().await; // skip the immediate first tick
        loop {
            tokio::select! {
                msg_opt = rx.recv() => {
                    match msg_opt {
                        Some(msg) => {
                            if ws_sender.send(Message::Text(msg.into())).await.is_err() {
                                break;
                            }
                        }
                        None => break,
                    }
                }
                _ = ping_interval.tick() => {
                    // fetch_add returns the value BEFORE increment: +1 = number of
                    // consecutive unacknowledged pings counting the one about to be sent.
                    let outstanding = pong_flag_send.fetch_add(1, Ordering::Relaxed) + 1;
                    if outstanding > MAX_MISSED_PONGS {
                        // INFO, like `Client went away without a closing handshake`: a phone that lost
                        // its network or a laptop that slept never answers, which is the ordinary
                        // end of most sessions and not a fault of the gateway.
                        tracing::info!(
                            "[heartbeat] No pong from {} after {} pings - closing dead connection",
                            conn_key_ping,
                            MAX_MISSED_PONGS
                        );
                        break;
                    }
                    tracing::debug!("[heartbeat] Sending ping to {}", conn_key_ping);
                    if ws_sender.send(Message::Ping(vec![].into())).await.is_err() {
                        break;
                    }
                }
            }
        }
    });

    // ── Recv task: parse frames + dispatch ────────────────────────────────
    let mut recv_task = {
        let state = state.clone();
        let user_id = user_id.clone();
        let device_id = device_id.clone();
        let conn_key_recv = conn_key.clone();
        let field_recv = field.clone();
        let pong_flag_recv = awaiting_pong.clone();
        let tx_for_dispatch = tx.clone();
        let client_recv = client.clone();

        tokio::spawn(async move {
            // Take ownership of the shared connection (or None in degraded mode).
            // On any Redis error we attempt a single reconnect via the client.
            let mut con_opt = redis_conn;
            // What this connection sent, written once when this task ends or is aborted.
            let mut frames = crate::frame_census::FrameCensus::open(&user_id, &device_id);
            // Set by a `disconnect` frame: the session is retired and the socket out of routing,
            // and the loop only waits for the client's Close (see the `"disconnect"` arm).
            let mut departed = false;

            while let Some(msg) = receiver.next().await {
                match msg {
                    Ok(Message::Pong(_)) if departed => {
                        // A retired session is not refreshed, and the missed-ping counter is NOT
                        // reset: the pong only says the client has not yet sent its Close. So a
                        // client that never sends it is ended by the heartbeat (send task) within
                        // PING_INTERVAL_SECS * (MAX_MISSED_PONGS + 1) of its `disconnect`.
                        continue;
                    }
                    Ok(Message::Text(text)) if departed => {
                        // A FRAME AFTER `disconnect` MEANS THE CLIENT DID NOT LEAVE: the socket is
                        // out of routing, so kept open it would be DEAF - nothing delivered, no
                        // pong - until the client's own watchdog gave up (4 heartbeats, ~32 s on
                        // the web). The known way in is a `beforeunload` the page cancelled (a
                        // "leave this page?" prompt answered "stay"): `disconnect` went out, the
                        // document stayed. Ending the socket here is the answer the client can act
                        // on at once - its next heartbeat sees it closed and reconnects.
                        tracing::warn!(
                            "[presence] {}:{} sent a {}-byte frame after its disconnect - its client stayed (a cancelled unload?); ending the socket so it reconnects",
                            user_id,
                            device_id,
                            text.len()
                        );
                        break;
                    }
                    Ok(Message::Pong(_)) => {
                        // Client is alive: reset the missed-ping counter and refresh TTL.
                        pong_flag_recv.store(0, Ordering::Relaxed);
                        refresh_presence(
                            &mut con_opt,
                            &state,
                            &conn_key_recv,
                            &field_recv,
                            declared,
                            &client_recv,
                        )
                        .await;
                        continue;
                    }
                    Ok(Message::Text(text)) => {
                        frames.note(text.len());
                        // Any inbound data frame proves the client is reachable
                        // end-to-end (not just the nginx TCP layer).
                        pong_flag_recv.store(0, Ordering::Relaxed);
                        refresh_presence(
                            &mut con_opt,
                            &state,
                            &conn_key_recv,
                            &field_recv,
                            declared,
                            &client_recv,
                        )
                        .await;

                        let json = match serde_json::from_str::<serde_json::Value>(&text) {
                            Ok(v) => v,
                            Err(e) => {
                                tracing::error!("JSON parse error from {}: {}", user_id, e);
                                continue;
                            }
                        };

                        // Application-level heartbeat: reply so the browser can detect
                        // liveness (WS protocol Pong frames do not fire `onmessage`).
                        if json.get("type").and_then(|v| v.as_str()) == Some("ping") {
                            frames.heartbeat();
                            if tx_for_dispatch
                                .send(r#"{"type":"pong"}"#.to_string())
                                .await
                                .is_err()
                            {
                                break;
                            }
                            continue;
                        }

                        let raw_len = text.len();
                        // A typing frame is ephemeral: its receive and routing lines are DEBUG,
                        // every other frame keeps INFO (see `EPHEMERAL_FRAMES`).
                        let ephemeral = json
                            .get("type")
                            .and_then(|v| v.as_str())
                            .is_some_and(is_ephemeral_frame);
                        if ephemeral {
                            tracing::debug!(
                                "Received WS JSON frame from {} ({} bytes)",
                                user_id,
                                raw_len
                            );
                        } else {
                            tracing::info!(
                                "Received WS JSON frame from {} ({} bytes)",
                                user_id,
                                raw_len
                            );
                        }

                        let frame = match WsFrame::parse(&json) {
                            Some(f) => f,
                            None => {
                                tracing::error!("Base64 decode error in frame from {}", user_id);
                                continue;
                            }
                        };

                        let rx_group = if frame.group_id.is_empty() {
                            "<none>"
                        } else {
                            &frame.group_id
                        };
                        if ephemeral {
                            tracing::debug!(
                                "[WS RX] from={}:{} type={} group={} rawBytes={}",
                                user_id,
                                device_id,
                                frame.msg_type,
                                rx_group,
                                raw_len
                            );
                        } else {
                            tracing::info!(
                                "[WS RX] from={}:{} type={} group={} rawBytes={}",
                                user_id,
                                device_id,
                                frame.msg_type,
                                rx_group,
                                raw_len
                            );
                        }

                        match frame.msg_type.as_str() {
                            "disconnect" => {
                                // THE SESSION ENDS NOW; THE SOCKET ENDS ON THE CLIENT'S CLOSE.
                                // Out of local routing first, so no frame published from here on
                                // is handed to a socket its client is closing; then the session
                                // is retired in Redis (`conn_id` keeps a sibling tab's presence).
                                // The loop then reads on: every client follows `disconnect` with
                                // its Close, and dropping the TCP connection before reading it
                                // made the frontend's nginx close with that frame unread - a
                                // reset at the edge (docs/wiki/services/chat-gateway.md).
                                state.remove_session(&conn_key_recv, conn_id);
                                handle_disconnect(&state, &user_id, &device_id, conn_id).await;
                                departed = true;
                                continue;
                            }
                            retired if is_retired_frame(retired) => {
                                handle_retired_frame(&user_id, &device_id, &frame);
                            }
                            "typing" => {
                                let conn = WsConn {
                                    state: &state,
                                    user_id: &user_id,
                                    device_id: &device_id,
                                };
                                handle_typing(&conn, &frame).await;
                            }
                            _ => {}
                        }

                        log_routing(&user_id, &device_id, &frame);
                    }
                    Ok(Message::Close(c)) => {
                        // NOT a break: the next read sends the Close reply tungstenite queued and
                        // then ends the stream, so the handshake completes before the TCP close.
                        tracing::info!("Client closed connection: {:?}", c);
                        continue;
                    }
                    Err(e) => {
                        match classify_socket_error(&e) {
                            // Beside `Client closed connection` above, at the SAME level: the two
                            // lines are one event - a session ended - differing only in whether the
                            // client was polite enough to say so. Splitting them across levels
                            // would re-create, one rung down, exactly the defect this fixes.
                            SocketEnd::Goodbye => {
                                tracing::info!("Client went away without a closing handshake")
                            }
                            SocketEnd::Fault => {
                                tracing::error!("WebSocket Error from {}: {}", user_id, e);
                            }
                            SocketEnd::Unreadable => tracing::error!(
                                "WebSocket Error from {} COULD NOT BE CLASSIFIED - the error under \
                                 axum's is not a tungstenite::Error, so this crate's direct \
                                 tokio-tungstenite dependency no longer unifies with axum's and \
                                 every ordinary goodbye is being reported here as a fault: {}",
                                user_id,
                                e
                            ),
                        }
                        break;
                    }
                    _ => {}
                }
            }
        })
    };

    tokio::select! {
        _ = (&mut send_task) => recv_task.abort(),
        _ = (&mut recv_task) => send_task.abort(),
    };
    // Cleanup handled by ConnectionGuard's Drop.
}

// ── Presence refresh helper ───────────────────────────────────────────────

/// Record what this device declared, beside its presence and with the same TTL, for the anonymous
/// census ([`crate::census`]). A failure costs the census one device's label (it counts as
/// `unknown`) and nothing else, so it is logged and never propagated.
async fn note_client(
    con: &mut redis::aio::MultiplexedConnection,
    conn_key: &str,
    client: &crate::census::ClientKind,
) {
    if let Err(e) = crate::census::note_client(con, conn_key, client, PRESENCE_TTL_SECS).await {
        // No conn_key: it holds a user id, and the census names nobody.
        tracing::warn!("[census] could not record a device's declaration: {}", e);
    }
}

/// Refresh the `user:online:{userId}:{deviceId}` Redis TTL to [`PRESENCE_TTL_SECS`], with this
/// session's field in the device's sessions hash ([`crate::addressing::write_session`]).
///
/// Uses the socket-local multiplexed connection to avoid opening a new TCP
/// connection per frame.  If the connection is missing or has gone stale, it
/// attempts a single reconnect and stores the new connection back into
/// `con_opt` for future calls.
async fn refresh_presence(
    con_opt: &mut Option<redis::aio::MultiplexedConnection>,
    state: &Arc<AppState>,
    conn_key: &str,
    field: &str,
    declared: crate::addressing::SessionCaps,
    client: &crate::census::ClientKind,
) {
    // Try the existing connection first.
    if let Some(con) = con_opt.as_mut() {
        match crate::addressing::write_session(con, conn_key, field, declared, PRESENCE_TTL_SECS)
            .await
        {
            Ok(true) => {
                note_client(con, conn_key, client).await;
                return;
            }
            Ok(false) => {
                // The session was retired while this refresh was in flight: nothing was written,
                // which is the point (crate::addressing, the left hash).
                tracing::info!(
                    "[presence] Refresh of retired session {} of {} wrote nothing",
                    field,
                    conn_key
                );
                return;
            }
            Err(e) => {
                tracing::warn!(
                    "[presence] presence refresh failed for {} (will reconnect): {}",
                    conn_key,
                    e
                );
                *con_opt = None; // mark as dead
            }
        }
    }

    // Connection is dead or was never established - attempt a single reconnect.
    match state.redis_client.get_multiplexed_async_connection().await {
        Ok(mut new_con) => {
            if let Err(e) = crate::addressing::write_session(
                &mut new_con,
                conn_key,
                field,
                declared,
                PRESENCE_TTL_SECS,
            )
            .await
            {
                tracing::warn!(
                    "[presence] presence refresh after reconnect failed for {}: {}",
                    conn_key,
                    e
                );
            } else {
                tracing::info!(
                    "[presence] Reconnected to Redis and refreshed TTL for {}",
                    conn_key
                );
                note_client(&mut new_con, conn_key, client).await;
                *con_opt = Some(new_con);
            }
        }
        Err(e) => {
            tracing::warn!(
                "[presence] Redis unreachable during presence refresh for {}: {}",
                conn_key,
                e
            );
        }
    }
}

// ── Routing diagnostics ───────────────────────────────────────────────────

/// One line per received frame saying where it is routed: type, group, sender. The group's member
/// list is NOT in it - it was the whole line's weight on a busy group and Redis answered it on
/// every frame; who is online is what `connected_users` and presence already say. A typing frame
/// is ephemeral (`EPHEMERAL_FRAMES`) and is logged at DEBUG.
fn log_routing(user_id: &str, device_id: &str, frame: &WsFrame) {
    let ephemeral = is_ephemeral_frame(&frame.msg_type);
    let group = if frame.group_id.is_empty() {
        "<none>"
    } else {
        frame.group_id.as_str()
    };
    if ephemeral {
        tracing::debug!(
            "[ROUTE] type={} group={} from={}:{}",
            frame.msg_type,
            group,
            user_id,
            device_id
        );
    } else {
        tracing::info!(
            "[ROUTE] type={} group={} from={}:{}",
            frame.msg_type,
            group,
            user_id,
            device_id
        );
    }
}

#[cfg(test)]
mod tests {

    use super::{SocketEnd, classify_socket_error};
    use tokio_tungstenite::tungstenite::{Error as WsError, error::ProtocolError};

    /// Everything below reached `tracing::error!` before 2026-09-15, which is what made the
    /// gateway's ERROR channel say nothing: the ONE case that is not a defect outnumbered the rest
    /// 32 to 0 on production over a week. Three of these four assertions are therefore the fix and
    /// the fourth is the control.
    fn end_of(err: WsError) -> SocketEnd {
        classify_socket_error(&axum::Error::new(err))
    }

    #[test]
    fn a_reset_with_no_handshake_is_somebody_closing_a_tab() {
        assert_eq!(
            end_of(WsError::Protocol(
                ProtocolError::ResetWithoutClosingHandshake
            )),
            SocketEnd::Goodbye
        );
    }

    #[test]
    fn the_control_a_real_protocol_fault_is_still_a_fault() {
        // Same `Protocol` wrapper as the case above, so this pins that the discriminator is the
        // VARIANT and not merely "it was a protocol error".
        assert_eq!(
            end_of(WsError::Protocol(ProtocolError::UnmaskedFrameFromClient)),
            SocketEnd::Fault
        );
    }

    #[test]
    fn the_tempting_widening_is_refused_connection_closed_stays_a_fault() {
        // `ConnectionClosed` reads like a goodbye and is the obvious second variant to fold in.
        // It is NOT folded in, because it was not among the 32 lines measured: a predicate widened
        // to cover a case nobody has observed cannot later report that case. If it does start
        // appearing it will be the only ERROR line on the box, which is the whole point.
        assert_eq!(end_of(WsError::ConnectionClosed), SocketEnd::Fault);
        assert_eq!(end_of(WsError::AlreadyClosed), SocketEnd::Fault);
    }

    /// `end_of` boxes THIS crate's `tungstenite` type, so it passes whatever axum resolves - it
    /// was green while production read every goodbye as unreadable (2026-10-07: #944 split the
    /// direct dependency from axum's). The only thing that sees the split is the lockfile.
    #[test]
    fn one_tokio_tungstenite_in_the_lock() {
        let lock = include_str!("../Cargo.lock");
        let n = lock.matches("name = \"tokio-tungstenite\"").count();
        assert_eq!(
            n, 1,
            "Cargo.lock holds {n} tokio-tungstenite versions: the direct dependency no longer              unifies with axum's and classify_socket_error cannot read a socket error"
        );
    }

    #[test]
    fn an_error_that_is_not_a_tungstenite_error_accuses_rather_than_guesses() {
        // The shape a future axum bump would produce if it stopped unifying with this crate's
        // direct `tokio-tungstenite`. It must NOT read as a goodbye: silently reclassifying every
        // session end as normal is strictly worse than the noise this change removes.
        let foreign = axum::Error::new(std::io::Error::other("not a websocket error"));
        assert_eq!(classify_socket_error(&foreign), SocketEnd::Unreadable);
    }

    // ── Admission, as a client sees it ────────────────────────────────────

    use super::{Admitted, ConnectionGuard, refuse_admission, ws_handler};
    use crate::audience::PresenceAudience;
    use crate::state::{AdmissionRefusal, AppState};
    use axum::{Router, http::StatusCode, routing::get};
    use std::sync::Arc;
    use tokio::sync::mpsc;

    const SECRET: &str = "test-secret";

    /// An `AppState` with no I/O: `Client::open` only parses the URL.
    fn state() -> AppState {
        AppState::new(
            redis::Client::open("redis://127.0.0.1:1/").unwrap(),
            SECRET.to_string(),
            PresenceAudience::new(String::new(), String::new(), String::new()),
        )
    }

    /// An access token for `user`, signed with [`SECRET`].
    fn token_of(user: &str) -> String {
        jsonwebtoken::encode(
            &jsonwebtoken::Header::new(jsonwebtoken::Algorithm::HS256),
            &crate::models::Claims {
                sub: user.to_string(),
                exp: 4_000_000_000,
                kind: Some("access".to_string()),
            },
            &jsonwebtoken::EncodingKey::from_secret(SECRET.as_bytes()),
        )
        .unwrap()
    }

    /// Serve `/api/ws` over `state` on a free local port; returns the socket URL of `user`'s
    /// `device`.
    async fn serve(state: Arc<AppState>) -> impl Fn(&str, &str) -> String {
        let app = Router::new()
            .route("/api/ws", get(ws_handler))
            .with_state(state);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        move |user: &str, device: &str| {
            format!(
                "ws://{addr}/api/ws?token={}&device_id={device}",
                token_of(user)
            )
        }
    }

    /// A handshake naming `origin`, against a gateway that lists `https://app.example`.
    async fn handshake_from(
        origin: Option<&str>,
        listed: crate::origin::UpgradeOrigins,
    ) -> Result<StatusCode, StatusCode> {
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;

        let mut state = state();
        state.upgrade_origins = listed;
        let url = serve(Arc::new(state)).await;
        let mut request = url("user-1", "device-1").into_client_request().unwrap();
        if let Some(origin) = origin {
            request
                .headers_mut()
                .insert("origin", origin.parse().unwrap());
        }
        match tokio_tungstenite::connect_async(request).await {
            Ok((_socket, answer)) => Ok(answer.status()),
            Err(WsError::Http(answer)) => Err(answer.status()),
            Err(other) => panic!("neither an open socket nor an HTTP answer: {other:?}"),
        }
    }

    fn app_only() -> crate::origin::UpgradeOrigins {
        crate::origin::UpgradeOrigins::parse("https://app.example,tauri://localhost")
    }

    #[tokio::test]
    async fn a_socket_opens_from_a_listed_origin_and_from_no_origin() {
        assert_eq!(
            handshake_from(Some("https://app.example"), app_only()).await,
            Ok(StatusCode::SWITCHING_PROTOCOLS)
        );
        assert_eq!(
            handshake_from(Some("tauri://localhost"), app_only()).await,
            Ok(StatusCode::SWITCHING_PROTOCOLS)
        );
        // A native client: no page, no Origin.
        assert_eq!(
            handshake_from(None, app_only()).await,
            Ok(StatusCode::SWITCHING_PROTOCOLS)
        );
    }

    #[tokio::test]
    async fn an_upgrade_from_an_origin_that_is_not_listed_is_a_403_with_a_valid_token() {
        assert_eq!(
            handshake_from(Some("https://sibling.app.example"), app_only()).await,
            Err(StatusCode::FORBIDDEN)
        );
        assert_eq!(
            handshake_from(Some("null"), app_only()).await,
            Err(StatusCode::FORBIDDEN)
        );
    }

    #[tokio::test]
    async fn a_wildcard_admits_no_page_and_still_admits_a_native_client() {
        let wildcard = crate::origin::UpgradeOrigins::Wildcard;

        assert_eq!(
            handshake_from(Some("https://app.example"), wildcard.clone()).await,
            Err(StatusCode::FORBIDDEN)
        );
        assert_eq!(
            handshake_from(None, wildcard).await,
            Ok(StatusCode::SWITCHING_PROTOCOLS)
        );
    }

    #[test]
    fn a_refused_origin_is_counted_under_its_own_name_and_takes_no_place() {
        let mut state = state();
        state.upgrade_origins = app_only();
        let mut headers = axum::http::HeaderMap::new();
        headers.insert("origin", "https://other.example".parse().unwrap());

        assert!(super::admit_origin(&state, &headers).is_err());
        assert!(super::admit_origin(&state, &headers).is_err());

        // Two refusals counted under the origin: the third prints nothing, another origin is new.
        assert_eq!(state.refused_origins.hit("https://other.example"), None);
        assert_eq!(state.refused_origins.hit("https://third.example"), Some(1));
        assert!(state.connected_users.lock().unwrap().is_empty());
    }

    /// THE REFUSAL IS AN HTTP ANSWER, NOT A SOCKET THAT OPENS AND CLOSES. A client resets its
    /// reconnection delay when its socket OPENS, so a refusal delivered after the upgrade would be
    /// asked again at the shortest delay, forever. Here the handshake itself fails.
    #[tokio::test]
    async fn a_request_past_the_limit_fails_before_the_socket_opens() {
        let mut state = state();
        state.max_connections_per_account = 1;
        let state = Arc::new(state);
        let url = serve(state.clone()).await;

        let (_held, answer) = tokio_tungstenite::connect_async(url("user-1", "device-1"))
            .await
            .expect("the first socket of the account opens");
        assert_eq!(answer.status(), StatusCode::SWITCHING_PROTOCOLS);

        let refused = tokio_tungstenite::connect_async(url("user-1", "device-2")).await;

        match refused {
            Err(WsError::Http(answer)) => {
                assert_eq!(answer.status(), StatusCode::SERVICE_UNAVAILABLE)
            }
            other => panic!("the handshake must fail with a 503, got {other:?}"),
        }
        assert!(
            !state
                .connected_users
                .lock()
                .unwrap()
                .contains_key("user-1:device-2")
        );

        // Another account is not refused by the first one's limit.
        tokio_tungstenite::connect_async(url("user-2", "device-1"))
            .await
            .expect("another account still opens a socket");
    }

    /// The place is held by the guard the upgrade callback owns: a callback dropped unrun (an
    /// upgrade that never completed) gives it back.
    #[tokio::test]
    async fn a_place_whose_upgrade_never_ran_is_given_back() {
        let state = Arc::new(state());
        let (tx, rx) = mpsc::channel::<String>(1);
        state
            .admit(
                "user-1",
                "user-1:device-1",
                7,
                tx.clone(),
                crate::addressing::SessionCaps::default(),
            )
            .unwrap();
        let admitted = Admitted {
            guard: ConnectionGuard {
                state: state.clone(),
                conn_key: "user-1:device-1".to_string(),
                field: crate::addressing::session_field(&state.instance_id, 7),
                conn_id: 7,
            },
            tx,
            rx,
        };

        drop(admitted);

        assert!(state.connected_users.lock().unwrap().is_empty());
        assert!(!state.session_caps.lock().unwrap().contains_key(&7));
    }

    #[test]
    fn a_refusal_is_a_503() {
        let state = state();

        let answer = refuse_admission(&state, "user-a", &AdmissionRefusal::Process { held: 1_000 });

        assert_eq!(answer.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    /// A raw client that hangs up the moment the server starts answering, without ever speaking
    /// the protocol: the place taken before the answer comes back. (A client that hangs up BEFORE
    /// the server reads its request never reaches the handler, so it takes no place at all; the
    /// upgrade that fails after admission is covered by `a_place_whose_upgrade_never_ran_is_given_back`.)
    #[tokio::test]
    async fn a_client_that_hangs_up_as_the_answer_starts_leaves_no_place_taken() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let state = Arc::new(state());
        let url = serve(state.clone()).await;
        let url = url("user-1", "device-1");
        let rest = url.strip_prefix("ws://").unwrap();
        let (host, path) = rest.split_once('/').unwrap();

        let mut link = tokio::net::TcpStream::connect(host).await.unwrap();
        link.write_all(
            format!(
                "GET /{path} HTTP/1.1\r\nHost: {host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"
            )
            .as_bytes(),
        )
        .await
        .unwrap();
        let mut first = [0u8; 1];
        link.read_exact(&mut first).await.unwrap();
        drop(link);

        // Bounded by a count of turns, so a place that never comes back FAILS instead of hanging.
        let mut emptied = false;
        for _ in 0..500 {
            if state.connected_users.lock().unwrap().is_empty()
                && state
                    .next_conn_id
                    .load(std::sync::atomic::Ordering::Relaxed)
                    == 1
            {
                emptied = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(
            emptied,
            "the place taken for the upgrade was never given back (ids handed out: {}, keys held: {:?})",
            state
                .next_conn_id
                .load(std::sync::atomic::Ordering::Relaxed),
            state
                .connected_users
                .lock()
                .unwrap()
                .keys()
                .collect::<Vec<_>>()
        );
    }

    // ── A `disconnect`, as a client sees it ──────────────────────────────

    /// The reset of 2026-11-13 (docs/wiki/services/chat-gateway.md): the gateway answered
    /// `disconnect` by dropping the TCP connection, before the Close every client sends next was
    /// read. Now the socket leaves routing at once and ends on the client's Close: the client's
    /// first frame back is the Close REPLY, which only a server that read the Close can send.
    #[tokio::test]
    async fn a_disconnect_leaves_routing_at_once_and_the_socket_ends_on_the_clients_close() {
        use futures::{SinkExt, StreamExt};
        use tokio_tungstenite::tungstenite::Message;

        let state = Arc::new(state());
        let url = serve(state.clone()).await;
        let (mut socket, _) = tokio_tungstenite::connect_async(url("user-1", "device-1"))
            .await
            .unwrap();
        socket
            .send(Message::Text(r#"{"type":"disconnect"}"#.into()))
            .await
            .unwrap();

        // Bounded by a count of turns, so a socket that never leaves routing FAILS instead of
        // hanging.
        let mut left = false;
        for _ in 0..500 {
            if state.connected_users.lock().unwrap().is_empty() {
                left = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(left, "the socket was still routable after its disconnect");
        assert!(
            state.session_caps.lock().unwrap().is_empty(),
            "the session's declaration outlived its disconnect"
        );

        socket.close(None).await.unwrap();

        match socket.next().await {
            Some(Ok(Message::Close(_))) => {}
            other => panic!(
                "the first frame after a disconnect must be the Close reply (the server read the \
                 client's Close before ending the connection), got {other:?}"
            ),
        }
        assert!(
            socket.next().await.is_none(),
            "the socket must end after the closing handshake"
        );
    }

    /// A client that sends a frame after its `disconnect` did not leave (a `beforeunload` the page
    /// cancelled). Its socket is out of routing, so kept open it would be deaf; the gateway ends it,
    /// and the client sees the end at once instead of a pong - never the pong of a live socket.
    #[tokio::test]
    async fn a_frame_after_a_disconnect_ends_the_deaf_socket() {
        use futures::{SinkExt, StreamExt};
        use tokio_tungstenite::tungstenite::Message;

        let state = Arc::new(state());
        let url = serve(state.clone()).await;
        let (mut socket, _) = tokio_tungstenite::connect_async(url("user-1", "device-1"))
            .await
            .unwrap();
        socket
            .send(Message::Text(r#"{"type":"disconnect"}"#.into()))
            .await
            .unwrap();
        socket
            .send(Message::Text(r#"{"type":"ping"}"#.into()))
            .await
            .unwrap();

        // The next thing the client reads is the end of the connection. A socket kept open would
        // answer nothing until the heartbeat's first ping (PING_INTERVAL_SECS later), which is a
        // frame and fails here - the proof is what is read, not how long it took.
        match socket.next().await {
            None | Some(Err(_)) => {}
            Some(Ok(frame)) => {
                panic!("a departed socket that sent a frame was kept open, it read {frame:?}")
            }
        }
        assert!(state.connected_users.lock().unwrap().is_empty());
    }
}
