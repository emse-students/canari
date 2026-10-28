mod addressing;
mod audience;
mod handlers;
mod models;
mod presence;
mod state;
mod subscribers;
mod ws_dispatch;

use axum::{
    Router,
    http::{HeaderValue, Method, StatusCode},
    response::IntoResponse,
    routing::get,
};
use std::{net::SocketAddr, sync::Arc};
use tower_http::cors::{AllowHeaders, AllowOrigin, Any, CorsLayer};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

use crate::audience::PresenceAudience;
use crate::handlers::ws_handler;
use crate::presence::{get_admin_presence, get_presence, post_presence};
use crate::state::AppState;

/// Liveness probe endpoint - returns `200 OK` with body `"OK"`.
async fn health_check() -> impl IntoResponse {
    (StatusCode::OK, "OK")
}

/// Splits a comma-separated `ALLOW_ORIGIN` into the exact origins the CORS layer will match.
///
/// Blank segments are dropped so a trailing comma is not an error, and a segment that cannot be a
/// header value is skipped with a WARN naming it - one unusable spelling must not cost the other
/// four their policy. Note that a `HeaderValue` accepts almost any printable ASCII, so this
/// rejects malformed BYTES and not malformed ORIGINS: `htp:/typo` parses happily and will simply
/// match nothing. **The only proof an origin list is right is reading the served
/// `access-control-allow-origin` back after the deploy**, never the deploy's colour.
///
/// @param allow_origin - Raw `ALLOW_ORIGIN` value, e.g. `https://canari-emse.fr,tauri://localhost`.
fn parse_allowed_origins(allow_origin: &str) -> Vec<HeaderValue> {
    let mut origins: Vec<HeaderValue> = Vec::new();
    for part in allow_origin.split(',') {
        let s = part.trim();
        if s.is_empty() {
            continue;
        }
        match s.parse::<HeaderValue>() {
            Ok(h) => origins.push(h),
            Err(e) => tracing::warn!("ALLOW_ORIGIN segment '{}' ignored: {}", s, e),
        }
    }
    origins
}

/// CORS for `/api/ws` (browser `Origin`) and HTTP helpers on the same router.
/// `ALLOW_ORIGIN=*` allows all. Otherwise use a comma-separated list, e.g.
/// `https://canari-emse.fr,http://localhost:1420` so local Vite (`Origin: http://localhost:1420`)
/// is accepted when the chat-gateway runs with a non-wildcard policy.
///
/// THE LIST IS A FACT ABOUT THE CLIENTS, AND EVERY CANARI CLIENT MUST BE IN IT. A Tauri WebView
/// presents one origin per platform and calls this gateway cross-origin (its page is served from
/// `tauri://localhost`, the API from `https://canari-emse.fr`), so omitting a spelling here costs
/// that platform `/api/presence` with no server-side error to show for it - the same failure shape
/// that cost iOS its login through the Nest services' own list (`apps/*/src/cors-origins.ts`,
/// which this must be kept in step with).
///
/// THE ALLOWED HEADERS ARE THE ONES THE PREFLIGHT ASKS FOR, NEVER `*`. A wildcard
/// `access-control-allow-headers` does NOT cover `Authorization` (Fetch standard, CORS-preflight
/// fetch), so a browser that follows the standard refuses every Bearer read of `/api/presence`
/// once the phone apps read through the WebView (`fetchRouting.ts`, 2026-10-15) - a transport
/// failure, and the app would flap offline. Mirroring the request is what the Nest services'
/// `cors` package does when `allowedHeaders` is unset.
///
/// The preflight is cached for [`CORS_PREFLIGHT_MAX_AGE`], so a read pays it once per URL rather
/// than on every call.
fn chat_gateway_cors_layer(allow_origin: &str) -> CorsLayer {
    let common = CorsLayer::new()
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers(AllowHeaders::mirror_request())
        .max_age(CORS_PREFLIGHT_MAX_AGE);

    if allow_origin.trim() == "*" {
        return common.allow_origin(Any);
    }

    let origins = parse_allowed_origins(allow_origin);

    if origins.is_empty() {
        panic!(
            "ALLOW_ORIGIN has no valid HTTP origins ('{}'). Set ALLOW_ORIGIN to a comma-separated list of origins or '*' for development.",
            allow_origin
        );
    }

    if origins.len() == 1 {
        common.allow_origin(AllowOrigin::exact(origins[0].clone()))
    } else {
        common.allow_origin(AllowOrigin::list(origins))
    }
}

/// How long a browser may reuse an answered preflight. Chromium caps it at 2 h, WebKit at 10 min;
/// the services' `enableCors({ maxAge })` uses the same value.
const CORS_PREFLIGHT_MAX_AGE: std::time::Duration = std::time::Duration::from_secs(7200);

/// Masks credentials in a Redis URL for logging.
/// `redis://user:password@host:port` -> `redis://host:port`
fn mask_redis_url(url: &str) -> String {
    if let Some(rest) = url.strip_prefix("redis://")
        && let Some(at_pos) = rest.find('@')
    {
        return format!("redis://{}", &rest[at_pos + 1..]);
    }
    url.to_string()
}

#[tokio::main]
async fn main() {
    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::new(
            std::env::var("RUST_LOG")
                .unwrap_or_else(|_| "chat_gateway=debug,tower_http=debug".into()),
        ))
        .with(tracing_subscriber::fmt::layer())
        .init();

    tracing::info!("=== Chat Gateway starting ===");

    // Redis connection
    let redis_url = std::env::var("REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1/".to_string());
    tracing::info!("Redis connection: {}", mask_redis_url(&redis_url));
    let redis_client = match redis::Client::open(redis_url.clone()) {
        Ok(c) => {
            tracing::info!("Redis client created");
            c
        }
        Err(e) => {
            tracing::error!("Invalid Redis URL '{}': {}", redis_url, e);
            std::process::exit(1);
        }
    };

    // JWT Secret
    let jwt_secret = match std::env::var("JWT_SECRET") {
        Ok(s) if !s.is_empty() => {
            tracing::info!("JWT_SECRET configured ({} chars)", s.len());
            s
        }
        Ok(_) => {
            tracing::error!("JWT_SECRET is empty");
            std::process::exit(1);
        }
        Err(_) => {
            tracing::error!("JWT_SECRET missing. Generate with: openssl rand -hex 32");
            std::process::exit(1);
        }
    };

    // Presence audience (WP-PRESENCE): who shares a conversation or a community with whom is asked
    // of the two services that own those tables. A missing value does not stop the gateway - the
    // socket must keep serving messages - but every presence read then answers 503, and this line
    // says why at boot rather than letting the first 503 be the clue.
    let service_url = |name: &str| {
        std::env::var(name).unwrap_or_else(|_| {
            tracing::error!(
                "{} is not set - every /api/presence read will answer 503 to every viewer",
                name
            );
            String::new()
        })
    };
    let delivery_url = service_url("DELIVERY_SERVICE_URL");
    let social_url = service_url("SOCIAL_SERVICE_URL");
    let internal_secret = std::env::var("INTERNAL_SECRET").unwrap_or_default();
    if internal_secret.is_empty() {
        tracing::error!(
            "INTERNAL_SECRET is not set - every /api/presence read will answer 503 to every viewer"
        );
    }
    let audience = PresenceAudience::new(delivery_url, social_url, internal_secret);

    let app_state = Arc::new(AppState::new(redis_client.clone(), jwt_secret, audience));

    // ── Redis pub/sub subscriber ──────────────────────────────────────────
    subscribers::spawn_redis_subscriber(
        redis_client.clone(),
        app_state.connected_users.clone(),
        app_state.session_caps.clone(),
    );

    // ── CORS configuration ────────────────────────────────────────────────
    // An UNSET variable means someone is running the binary by hand, and the wildcard keeps that
    // working. Every compose file names the variable, so reaching this branch under compose means
    // the policy this service is supposed to enforce silently became "anyone" - it is logged as an
    // accusation, not as a mode.
    let allow_origin = std::env::var("ALLOW_ORIGIN").unwrap_or_else(|_| {
        tracing::warn!(
            "ALLOW_ORIGIN is not set - falling back to '*', which accepts EVERY origin. Under \
             docker compose this variable is always declared, so this line means the declaration \
             was lost."
        );
        "*".to_string()
    });
    tracing::info!("CORS ALLOW_ORIGIN: {}", allow_origin);
    let cors = chat_gateway_cors_layer(&allow_origin);

    let app = Router::new()
        .route("/api/health", get(health_check))
        .route("/api/ws", get(ws_handler))
        // POST carries the ids in its body; GET is the legacy shim for installed clients
        // (docs/wiki/legacy-compatibility.md, "the presence ids in a URL").
        .route("/api/presence", get(get_presence).post(post_presence))
        .route("/api/admin/presence", get(get_admin_presence))
        .layer(cors)
        .with_state(app_state);

    let addr = SocketAddr::from(([0, 0, 0, 0], 3000));
    tracing::info!("Listening on {}", addr);
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => {
            tracing::info!("=== Chat Gateway started and ready on {} ===", addr);
            l
        }
        Err(e) => {
            tracing::error!("Failed to bind on {}: {}", addr, e);
            std::process::exit(1);
        }
    };

    if let Err(e) = serve_until(listener, app, terminate_signal()).await {
        tracing::error!("Erreur serveur axum: {}", e);
        std::process::exit(1);
    }
    tracing::info!("[DRAIN] every request in flight was answered - exiting");
}

/// Serves `app` until `shutdown` resolves, then stops ACCEPTING and returns once every request
/// already in flight has been answered.
///
/// WHY (2026-10-17, docs/wiki/cicd.md#a-deploy-replaces-nothing-a-member-is-talking-to): a release
/// starts the new gateway beside this one and retires this one with SIGTERM. This binary runs as
/// PID 1, where a signal with no handler is ignored, so the old gateway kept accepting until Docker
/// SIGKILLed it ten seconds later, mid-request. With the listener closed, a new connection is
/// REFUSED and nginx hands it to the new replica. An upgraded WebSocket is not "in flight" - its
/// connection left hyper at the upgrade - so it closes when the process exits and the client
/// reconnects, through nginx, to the new gateway.
async fn serve_until(
    listener: tokio::net::TcpListener,
    app: Router,
    shutdown: impl std::future::Future<Output = ()> + Send + 'static,
) -> std::io::Result<()> {
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown)
        .await
}

/// Resolves on SIGTERM - what `docker stop` sends. Off Unix (a developer's build only) on Ctrl-C.
async fn terminate_signal() {
    #[cfg(unix)]
    {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut sigterm) => {
                sigterm.recv().await;
            }
            Err(e) => {
                // Without the handler the process is back to ignoring SIGTERM as PID 1 and is killed
                // mid-request at the stop timeout - say so, loudly, and keep serving.
                tracing::error!(
                    "[DRAIN] cannot listen for SIGTERM ({e}) - a release will kill this gateway mid-request"
                );
                std::future::pending::<()>().await;
            }
        }
    }
    #[cfg(not(unix))]
    {
        if let Err(e) = tokio::signal::ctrl_c().await {
            tracing::error!("[DRAIN] cannot listen for Ctrl-C ({e})");
            std::future::pending::<()>().await;
        }
    }
    tracing::info!(
        "[DRAIN] SIGTERM - closing the listener; requests in flight are answered, then the process exits"
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, header};
    use tower::ServiceExt;

    /// The value CD writes into `infrastructure/.env` once `BASE_URL` names the canonical
    /// apex. Pinned here so a change to the deployed list has to change a test that says
    /// what each entry is for.
    ///
    /// BOTH public apexes are present, deliberately: the estate answers on `canari.emse.fr`
    /// and on the legacy `canari-emse.fr`, which apps already installed on a phone still
    /// call. While the secret still names the legacy one, `compute_allow_origin`
    /// deduplicates and emits the seven-entry list this used to pin - so this is the shape
    /// the renderer produces, not a claim about what is in the secret today.
    const PRODUCTION_ALLOW_ORIGIN: &str = "https://canari.emse.fr,https://canari-emse.fr,\
         https://dev.canari-emse.fr,http://localhost:1420,http://127.0.0.1:1420,\
         http://tauri.localhost,https://tauri.localhost,tauri://localhost";

    /// Minimal router carrying only the CORS layer, so what is asserted is the layer and nothing
    /// downstream of it.
    fn router(allow_origin: &str) -> Router {
        Router::new()
            .route("/api/presence", get(|| async { "ok" }))
            .layer(chat_gateway_cors_layer(allow_origin))
    }

    /// Sends a CORS preflight and returns the `access-control-allow-origin` that came back.
    async fn preflight(allow_origin: &str, origin: &str) -> Option<String> {
        let response = router(allow_origin)
            .oneshot(
                Request::builder()
                    .method(Method::OPTIONS)
                    .uri("/api/presence")
                    .header(header::ORIGIN, origin)
                    .header(header::ACCESS_CONTROL_REQUEST_METHOD, "GET")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        response
            .headers()
            .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
            .map(|v| v.to_str().unwrap().to_string())
    }

    /// Sends one raw `GET /slow` and returns the status line, or the transport error.
    async fn raw_get(addr: SocketAddr) -> std::io::Result<String> {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut stream = tokio::net::TcpStream::connect(addr).await?;
        stream
            .write_all(b"GET /slow HTTP/1.1\r\nHost: t\r\nConnection: close\r\n\r\n")
            .await?;
        let mut response = String::new();
        stream.read_to_string(&mut response).await?;
        Ok(response.lines().next().unwrap_or_default().to_string())
    }

    /// A gateway a release retires answers what it accepted and refuses what it has not: a refused
    /// connect is what nginx hands to the new replica (docs/wiki/cicd.md).
    #[tokio::test]
    async fn serve_until_answers_in_flight_and_refuses_new_connections() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = Router::new().route(
            "/slow",
            get(|| async {
                tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                "done"
            }),
        );
        let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
        let server = tokio::spawn(serve_until(listener, app, async {
            let _ = stopped.await;
        }));

        let in_flight = tokio::spawn(raw_get(addr));
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        stop.send(()).unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        assert!(
            tokio::net::TcpStream::connect(addr).await.is_err(),
            "a new connection must be refused once the drain has begun"
        );
        assert_eq!(in_flight.await.unwrap().unwrap(), "HTTP/1.1 200 OK");
        server.await.unwrap().unwrap();
    }

    #[test]
    fn keeps_every_segment_of_the_production_list() {
        let origins = parse_allowed_origins(PRODUCTION_ALLOW_ORIGIN);
        assert_eq!(origins.len(), 8, "one entry lost: {origins:?}");
    }

    #[test]
    fn drops_blank_segments_rather_than_failing_on_a_trailing_comma() {
        let origins = parse_allowed_origins("https://canari-emse.fr, ,tauri://localhost,");
        assert_eq!(origins, ["https://canari-emse.fr", "tauri://localhost"]);
    }

    #[tokio::test]
    async fn answers_every_canari_client_with_its_own_origin() {
        for origin in [
            "https://canari.emse.fr",
            "https://canari-emse.fr",
            "https://dev.canari-emse.fr",
            "http://localhost:1420",
            "http://127.0.0.1:1420",
            "http://tauri.localhost",
            "https://tauri.localhost",
            "tauri://localhost",
        ] {
            assert_eq!(
                preflight(PRODUCTION_ALLOW_ORIGIN, origin).await.as_deref(),
                Some(origin),
                "{origin} is a Canari client and was refused"
            );
        }
    }

    #[tokio::test]
    async fn sends_no_allow_origin_header_to_an_origin_that_is_not_ours() {
        assert_eq!(
            preflight(PRODUCTION_ALLOW_ORIGIN, "https://evil.example").await,
            None
        );
    }

    #[tokio::test]
    async fn varies_on_origin_so_a_cache_cannot_serve_one_clients_answer_to_another() {
        let response = router(PRODUCTION_ALLOW_ORIGIN)
            .oneshot(
                Request::builder()
                    .uri("/api/presence")
                    .header(header::ORIGIN, "https://canari-emse.fr")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let vary = response
            .headers()
            .get(header::VARY)
            .expect("no Vary: a shared cache would hand one origin's response to the next")
            .to_str()
            .unwrap()
            .to_string();
        assert!(
            vary.to_ascii_lowercase().contains("origin"),
            "vary was {vary}"
        );
    }

    /// A Bearer read from a phone app (`GET /api/presence` through the WebView) preflights
    /// `authorization, content-type`. A `*` answer does not cover `Authorization`, so the header
    /// must be named back, and the answer cached.
    #[tokio::test]
    async fn names_back_the_authorization_header_a_bearer_read_preflights() {
        let response = router(PRODUCTION_ALLOW_ORIGIN)
            .oneshot(
                Request::builder()
                    .method(Method::OPTIONS)
                    .uri("/api/presence")
                    .header(header::ORIGIN, "http://tauri.localhost")
                    .header(header::ACCESS_CONTROL_REQUEST_METHOD, "GET")
                    .header(
                        header::ACCESS_CONTROL_REQUEST_HEADERS,
                        "authorization,content-type",
                    )
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let allowed = response
            .headers()
            .get(header::ACCESS_CONTROL_ALLOW_HEADERS)
            .expect("no allow-headers")
            .to_str()
            .unwrap()
            .to_ascii_lowercase();
        assert!(allowed != "*", "a wildcard does not cover Authorization");
        assert!(
            allowed.contains("authorization"),
            "allow-headers was {allowed}"
        );
        assert_eq!(
            response
                .headers()
                .get(header::ACCESS_CONTROL_MAX_AGE)
                .unwrap(),
            "7200"
        );
    }

    /// The presence read is a POST since 2026-10-28 (the ids left the URL): a phone app's
    /// preflight asks for POST with a JSON body and a Bearer, and must be answered for each.
    #[tokio::test]
    async fn answers_the_preflight_of_a_presence_post() {
        let response = router(PRODUCTION_ALLOW_ORIGIN)
            .oneshot(
                Request::builder()
                    .method(Method::OPTIONS)
                    .uri("/api/presence")
                    .header(header::ORIGIN, "tauri://localhost")
                    .header(header::ACCESS_CONTROL_REQUEST_METHOD, "POST")
                    .header(
                        header::ACCESS_CONTROL_REQUEST_HEADERS,
                        "authorization,content-type",
                    )
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let header_of = |name| {
            response
                .headers()
                .get(name)
                .map(|v: &HeaderValue| v.to_str().unwrap().to_ascii_lowercase())
                .unwrap_or_default()
        };
        assert_eq!(
            header_of(header::ACCESS_CONTROL_ALLOW_ORIGIN),
            "tauri://localhost"
        );
        assert!(header_of(header::ACCESS_CONTROL_ALLOW_METHODS).contains("post"));
        assert!(header_of(header::ACCESS_CONTROL_ALLOW_HEADERS).contains("content-type"));
    }

    #[tokio::test]
    async fn a_wildcard_accepts_anyone() {
        assert_eq!(
            preflight("*", "https://evil.example").await.as_deref(),
            Some("*")
        );
    }

    #[test]
    #[should_panic(expected = "no valid HTTP origins")]
    fn refuses_to_boot_on_an_empty_list_rather_than_serving_a_policy_nobody_chose() {
        // A SET-BUT-EMPTY variable is not an unset one: `${ALLOW_ORIGIN}` on a missing `.env` key
        // reaches the container as "", which must stop the boot instead of silently allowing all.
        let _ = chat_gateway_cors_layer("");
    }
}
