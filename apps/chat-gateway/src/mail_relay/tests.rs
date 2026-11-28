use super::*;
use crate::audience::PresenceAudience;
use axum::{Json, Router, extract::Path, routing::get};
use tokio_tungstenite::tungstenite::{Error as WsError, Message as WsMessage};

const SECRET: &str = "test-secret";
const INTERNAL: &str = "internal-secret-for-tests";

// ── Configuration ────────────────────────────────────────────────────────────────────────────────

#[test]
fn one_host_port_is_the_only_upstream_accepted() {
    assert_eq!(
        Upstream::parse("partage.emse.fr:443"),
        Ok(Upstream {
            host: "partage.emse.fr".into(),
            port: 443
        })
    );
    assert!(Upstream::parse("127.0.0.1:9993").is_ok());
    for refused in [
        "",
        "partage.emse.fr",
        "partage.emse.fr:",
        "partage.emse.fr:0",
        "partage.emse.fr:65536",
        "partage.emse.fr:443,other.example:443",
        "partage.emse.fr:443 other.example:443",
        " partage.emse.fr:443",
        "https://partage.emse.fr:443",
        "partage.emse.fr:443/service/soap",
        "*.emse.fr:443",
        "*:443",
        "user@partage.emse.fr:443",
        ":443",
        ".emse.fr:443",
        "[::1]:443",
        "partage.emse.fr:+443",
    ] {
        assert!(
            matches!(
                Upstream::parse(refused),
                Err(ConfigRefusal::NotOneHostPort(_))
            ),
            "{refused:?} must be refused"
        );
    }
}

#[test]
fn the_relay_is_off_unless_switched_on() {
    let off = |v: Option<&str>| {
        RelayConfig::from_values(
            v,
            Some("partage.emse.fr:443"),
            Some("http://core"),
            Some("s"),
        )
    };
    assert_eq!(off(None), Ok(None));
    assert_eq!(off(Some("")), Ok(None));
    assert_eq!(off(Some("0")), Ok(None));
    assert_eq!(off(Some("false")), Ok(None));
    assert!(off(Some("1")).unwrap().is_some());
    assert!(off(Some("true")).unwrap().is_some());
    // A value that is neither stops the gateway rather than guessing.
    assert_eq!(
        off(Some("yes")),
        Err(ConfigRefusal::UnreadableSwitch("yes".into()))
    );
}

#[test]
fn an_incomplete_on_is_refused_at_startup() {
    assert_eq!(
        RelayConfig::from_values(Some("1"), None, Some("http://core"), Some("s")),
        Err(ConfigRefusal::NoUpstream)
    );
    assert!(matches!(
        RelayConfig::from_values(Some("1"), Some("a:1,b:2"), Some("http://core"), Some("s")),
        Err(ConfigRefusal::NotOneHostPort(_))
    ));
    assert_eq!(
        RelayConfig::from_values(Some("1"), Some("partage.emse.fr:443"), None, Some("s")),
        Err(ConfigRefusal::NoEligibilitySource("CORE_SERVICE_URL"))
    );
    assert_eq!(
        RelayConfig::from_values(
            Some("1"),
            Some("partage.emse.fr:443"),
            Some("http://c"),
            Some("")
        ),
        Err(ConfigRefusal::NoEligibilitySource("INTERNAL_SECRET"))
    );
    // Off, nothing else is read: an absent upstream is not a refusal.
    assert_eq!(RelayConfig::from_values(None, None, None, None), Ok(None));
}

// ── Eligibility ──────────────────────────────────────────────────────────────────────────────────

#[test]
fn the_classes_are_the_contracts() {
    let contract: serde_json::Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../libs/contracts/mail-domains.json"
    )))
    .unwrap();
    let mut listed: Vec<&str> = contract["classes"]
        .as_object()
        .unwrap()
        .values()
        .map(|c| c.as_str().unwrap())
        .collect();
    listed.sort_unstable();
    listed.dedup();
    let mut ours = MAIL_CLASSES.to_vec();
    ours.sort_unstable();
    assert_eq!(listed, ours);
}

#[test]
fn only_the_exact_classes_are_eligible() {
    assert!(is_eligible_class("student"));
    assert!(is_eligible_class("staff"));
    for refused in ["", "none", "Student", "alumni", "etu.emse.fr"] {
        assert!(!is_eligible_class(refused), "{refused:?}");
    }
}

/// A fake core-service answering `GET /api/internal/users/:id/mail-class`: `classes` maps an
/// account to its stored class, `null` for a known account with none; an absent account is a 404;
/// the account `broken` answers 503 (its database unreachable there).
async fn fake_core(classes: &[(&str, Option<&str>)]) -> String {
    let table: HashMap<String, Option<String>> = classes
        .iter()
        .map(|(a, d)| (a.to_string(), d.map(str::to_string)))
        .collect();
    let app = Router::new().route(
        "/api/internal/users/{id}/mail-class",
        get(move |Path(id): Path<String>, headers: HeaderMap| {
            let table = table.clone();
            async move {
                if headers
                    .get("x-internal-secret")
                    .and_then(|v| v.to_str().ok())
                    != Some(INTERNAL)
                {
                    return StatusCode::FORBIDDEN.into_response();
                }
                if id == "broken" {
                    return StatusCode::SERVICE_UNAVAILABLE.into_response();
                }
                match table.get(&id) {
                    Some(class) => Json(serde_json::json!({ "mailClass": class })).into_response(),
                    None => StatusCode::NOT_FOUND.into_response(),
                }
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    format!("http://{addr}")
}

#[tokio::test]
async fn core_services_answers_are_read_and_its_failures_are_not_answers() {
    let base = fake_core(&[("student", Some("student")), ("noaddress", None)]).await;
    let asks = Eligibility::new(base.clone(), INTERNAL.into());
    assert_eq!(
        asks.class_of("student").await.unwrap().as_deref(),
        Some("student")
    );
    assert_eq!(asks.class_of("noaddress").await.unwrap(), None);
    // Unknown: an answer, and not eligible.
    assert_eq!(asks.class_of("stranger").await.unwrap(), None);
    assert!(matches!(
        asks.class_of("broken").await,
        Err(EligibilityError::Upstream(503))
    ));
    // A refused secret is a fault, never "not eligible".
    let wrong = Eligibility::new(base, "not-ours".into());
    assert!(matches!(
        wrong.class_of("student").await,
        Err(EligibilityError::Upstream(403))
    ));
    let down = Eligibility::new("http://127.0.0.1:1".into(), INTERNAL.into());
    assert!(matches!(
        down.class_of("student").await,
        Err(EligibilityError::Unreachable(_))
    ));
}

#[test]
fn an_account_id_is_one_path_segment() {
    assert_eq!(urlencode_segment("abc-123_x.y~"), "abc-123_x.y~");
    assert_eq!(urlencode_segment("a/../b?c"), "a%2F..%2Fb%3Fc");
}

// ── Record counting ──────────────────────────────────────────────────────────────────────────────

#[test]
fn records_are_counted_by_type_across_any_split() {
    // A handshake record of 3 bytes, a CCS of 1, then application data of 4.
    let stream: Vec<u8> = [
        &[22, 3, 3, 0, 3, 1, 2, 3][..],
        &[20, 3, 3, 0, 1, 1][..],
        &[23, 3, 3, 0, 4, 9, 9, 9, 9][..],
    ]
    .concat();
    for split in 0..=stream.len() {
        let mut counter = RecordCounter::default();
        counter.observe(&stream[..split]);
        counter.observe(&stream[split..]);
        assert_eq!(
            (
                counter.handshake,
                counter.change_cipher_spec,
                counter.application_data,
                counter.alert,
                counter.other
            ),
            (1, 1, 1, 0, 0),
            "split at {split}"
        );
    }
    let mut not_tls = RecordCounter::default();
    not_tls.observe(b"GET / HTTP/1.1\r\n");
    assert!(not_tls.other >= 1);
}

// ── Places ───────────────────────────────────────────────────────────────────────────────────────

fn relay_to(upstream: &str, core: String) -> MailRelay {
    MailRelay::new(RelayConfig {
        upstream: Upstream::parse(upstream).unwrap(),
        core_url: core,
        internal_secret: INTERNAL.into(),
    })
}

#[test]
fn places_are_capped_per_account_then_per_process_and_given_back() {
    let mut relay = relay_to("127.0.0.1:9", String::new());
    relay.max_per_account = 2;
    relay.max_total = 3;
    let relay = Arc::new(relay);
    let now = Instant::now();
    let a1 = relay.admit("a", now).unwrap();
    let _a2 = relay.admit("a", now).unwrap();
    assert_eq!(relay.admit("a", now).err(), Some(PlaceRefusal::Account));
    let _b1 = relay.admit("b", now).unwrap();
    assert_eq!(relay.admit("c", now).err(), Some(PlaceRefusal::Process));
    // The account is counted first: the narrower reason is named.
    assert_eq!(relay.admit("a", now).err(), Some(PlaceRefusal::Account));
    drop(a1);
    assert!(
        relay.admit("c", now).is_ok(),
        "a place given back is free again"
    );
}

#[test]
fn new_connections_are_capped_per_account_over_a_rolling_minute() {
    let mut relay = relay_to("127.0.0.1:9", String::new());
    relay.max_new_per_window = 3;
    let relay = Arc::new(relay);
    let t0 = Instant::now();
    // Opened and closed at once: what is counted is the OPENS, not what is held.
    for s in 0..3 {
        drop(relay.admit("a", t0 + Duration::from_secs(s)).unwrap());
    }
    let refused = relay.admit("a", t0 + Duration::from_secs(30));
    assert_eq!(refused.err(), Some(PlaceRefusal::Rate));
    // Another account has its own window.
    assert!(relay.admit("b", t0 + Duration::from_secs(30)).is_ok());
    // A refused open is not counted: the first open leaves the window at t0 + 60 s, and one more
    // is admitted then, the second still inside.
    let at_60 = relay.admit("a", t0 + Duration::from_secs(60));
    assert!(at_60.is_ok(), "the first open left the window");
    drop(at_60);
    let at_60 = relay.admit("a", t0 + Duration::from_secs(60));
    assert_eq!(at_60.err(), Some(PlaceRefusal::Rate));
}

#[test]
fn bytes_are_budgeted_per_account_over_a_rolling_window() {
    let mut relay = relay_to("127.0.0.1:9", String::new());
    relay.byte_budget = 1_000;
    relay.byte_budget_window = Duration::from_secs(3_600);
    let relay = Arc::new(relay);
    let t0 = Instant::now();
    // Several connections of one account share ONE budget.
    assert_eq!(relay.charge("a", 600, t0), (600, true));
    assert_eq!(
        relay.charge("a", 400, t0 + Duration::from_secs(10)),
        (1_000, true)
    );
    assert_eq!(
        relay.charge("a", 1, t0 + Duration::from_secs(20)),
        (1_001, false)
    );
    assert_eq!(
        relay.admit("a", t0 + Duration::from_secs(30)).err(),
        Some(PlaceRefusal::Budget)
    );
    // Another account is not charged for it.
    assert!(relay.admit("b", t0 + Duration::from_secs(30)).is_ok());
    // The first 600 bytes leave the window an hour after they moved; the account is admitted again.
    assert!(relay.admit("a", t0 + Duration::from_secs(3_600)).is_ok());
}

// ── The route, served ────────────────────────────────────────────────────────────────────────────

fn token_of(user: &str) -> String {
    jsonwebtoken::encode(
        &jsonwebtoken::Header::new(jsonwebtoken::Algorithm::HS256),
        &crate::models::Claims {
            sub: user.to_string(),
            exp: 4_000_000_000,
            kind: Some("access".to_string()),
        },
        &jsonwebtoken::EncodingKey::from_secret(SECRET.as_bytes()).unwrap(),
    )
    .unwrap()
}

/// A TCP server that sends back every byte it receives, as the upstream would answer.
async fn echo_upstream() -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            tokio::spawn(async move {
                let (mut rx, mut tx) = socket.split();
                let _ = tokio::io::copy(&mut rx, &mut tx).await;
            });
        }
    });
    addr.to_string()
}

/// Serves `/api/mail/relay` over a state whose relay is `relay` (none = off); returns the URL of
/// `user`'s socket.
async fn serve(relay: Option<MailRelay>) -> impl Fn(&str) -> String {
    let mut state = AppState::new(
        redis::Client::open("redis://127.0.0.1:1/").unwrap(),
        SECRET.to_string(),
        PresenceAudience::new(String::new(), String::new(), String::new()),
    );
    state.upgrade_origins = crate::origin::UpgradeOrigins::parse("https://app.example");
    state.mail_relay = relay.map(Arc::new);
    let app = Router::new()
        .route("/api/mail/relay", get(mail_relay_handler))
        .with_state(Arc::new(state));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    move |user: &str| format!("ws://{addr}/api/mail/relay?token={}", token_of(user))
}

type Client =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn open(url: &str) -> Result<Client, StatusCode> {
    match tokio_tungstenite::connect_async(url).await {
        Ok((socket, _)) => Ok(socket),
        Err(WsError::Http(answer)) => Err(answer.status()),
        Err(other) => panic!("neither a socket nor an HTTP answer: {other:?}"),
    }
}

/// The next binary frame, or the close code that ended the socket.
async fn next_binary_or_close(socket: &mut Client) -> Result<Vec<u8>, Option<u16>> {
    loop {
        match socket.next().await {
            Some(Ok(WsMessage::Binary(b))) => return Ok(b.to_vec()),
            Some(Ok(WsMessage::Close(frame))) => return Err(frame.map(|f| u16::from(f.code))),
            Some(Ok(_)) => continue,
            Some(Err(_)) | None => return Err(None),
        }
    }
}

#[tokio::test]
async fn bytes_cross_the_relay_both_ways_unchanged() {
    let core = fake_core(&[("student", Some("student"))]).await;
    let url = serve(Some(relay_to(&echo_upstream().await, core))).await;
    let mut socket = open(&url("student")).await.unwrap();
    // A handshake record, as a client's first bytes would be; then a second message.
    let hello = vec![22u8, 3, 1, 0, 4, 1, 0, 0, 0];
    socket
        .send(WsMessage::Binary(hello.clone().into()))
        .await
        .unwrap();
    assert_eq!(next_binary_or_close(&mut socket).await.unwrap(), hello);
    let data: Vec<u8> = (0..=255u8).collect();
    socket
        .send(WsMessage::Binary(data.clone().into()))
        .await
        .unwrap();
    let mut echoed = Vec::new();
    while echoed.len() < data.len() {
        echoed.extend(next_binary_or_close(&mut socket).await.unwrap());
    }
    assert_eq!(echoed, data);
}

/// The close code an upgraded socket is refused with at once, before any byte crosses.
async fn refused_with(url: &str) -> Option<u16> {
    let mut socket = open(url).await.expect("an account refusal upgrades first");
    next_binary_or_close(&mut socket).await.err().flatten()
}

#[tokio::test]
async fn an_ineligible_account_is_closed_with_its_code_before_any_byte() {
    let core = fake_core(&[("alumnus", Some("alumni")), ("noaddress", None)]).await;
    let url = serve(Some(relay_to(&echo_upstream().await, core))).await;
    for account in ["alumnus", "noaddress", "stranger"] {
        assert_eq!(
            refused_with(&url(account)).await,
            Some(close_code::NOT_ELIGIBLE),
            "{account}"
        );
    }
}

#[tokio::test]
async fn an_eligibility_nobody_could_establish_is_its_own_code_not_a_refusal() {
    let core = fake_core(&[]).await;
    let url = serve(Some(relay_to(&echo_upstream().await, core))).await;
    assert_eq!(
        refused_with(&url("broken")).await,
        Some(close_code::UNAVAILABLE)
    );
}

#[test]
fn the_close_codes_are_distinct_and_in_the_private_range() {
    let codes = [
        close_code::UPSTREAM_CLOSED,
        close_code::BYTE_CAP,
        close_code::UPSTREAM_ERROR,
        close_code::PROTOCOL,
        close_code::IDLE,
        close_code::NOT_ELIGIBLE,
        close_code::CAP,
        close_code::UNAVAILABLE,
    ];
    let mut sorted = codes.to_vec();
    sorted.sort_unstable();
    sorted.dedup();
    assert_eq!(sorted.len(), codes.len());
    assert!(codes.iter().all(|c| (4000..5000).contains(c)));
    // The client reads the same numbers (frontend/src/lib/mail/relayTransport.ts, RELAY_CLOSE).
    let client = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../frontend/src/lib/mail/relayTransport.ts"
    ));
    for (name, code) in [
        ("UPSTREAM_CLOSED", close_code::UPSTREAM_CLOSED),
        ("BYTE_CAP", close_code::BYTE_CAP),
        ("UPSTREAM_ERROR", close_code::UPSTREAM_ERROR),
        ("PROTOCOL", close_code::PROTOCOL),
        ("IDLE", close_code::IDLE),
        ("NOT_ELIGIBLE", close_code::NOT_ELIGIBLE),
        ("CAP", close_code::CAP),
        ("UNAVAILABLE", close_code::UNAVAILABLE),
    ] {
        assert!(
            client.contains(&format!("  {name}: {code},")),
            "relayTransport.ts must name {name}: {code}"
        );
    }
}

#[tokio::test]
async fn the_route_is_a_404_while_the_switch_is_off() {
    let url = serve(None).await;
    assert_eq!(
        open(&url("student")).await.err(),
        Some(StatusCode::NOT_FOUND)
    );
}

#[tokio::test]
async fn no_token_or_a_foreign_origin_opens_nothing() {
    let core = fake_core(&[("student", Some("student"))]).await;
    let url = serve(Some(relay_to(&echo_upstream().await, core))).await;
    let bare = url("student");
    let bare = bare.split('?').next().unwrap().to_string();
    assert_eq!(open(&bare).await.err(), Some(StatusCode::UNAUTHORIZED));

    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    let mut request = url("student").into_client_request().unwrap();
    request
        .headers_mut()
        .insert("origin", "https://other.example".parse().unwrap());
    match tokio_tungstenite::connect_async(request).await {
        Err(WsError::Http(answer)) => assert_eq!(answer.status(), StatusCode::FORBIDDEN),
        other => panic!("expected a 403, got {:?}", other.map(|_| ())),
    }
}

/// Whether a socket at `url` is admitted: a byte sent comes back from the echo upstream.
async fn admitted(url: &str) -> bool {
    let mut socket = open(url).await.unwrap();
    socket
        .send(WsMessage::Binary(vec![7u8].into()))
        .await
        .unwrap();
    next_binary_or_close(&mut socket).await == Ok(vec![7u8])
}

#[tokio::test]
async fn an_account_past_its_cap_is_closed_with_its_code_and_a_closed_socket_frees_its_place() {
    let core = fake_core(&[("student", Some("student"))]).await;
    let mut relay = relay_to(&echo_upstream().await, core);
    relay.max_per_account = 2;
    let url = serve(Some(relay)).await;
    let mut first = open(&url("student")).await.unwrap();
    let _second = open(&url("student")).await.unwrap();
    assert_eq!(refused_with(&url("student")).await, Some(close_code::CAP));
    first.close(None).await.unwrap();
    while first.next().await.is_some() {}
    // The place is given back when the relay's task ends, right after the close handshake: the
    // loop waits for that task, a refused attempt is not counted against the rate.
    let mut reopened = false;
    for _ in 0..50 {
        if admitted(&url("student")).await {
            reopened = true;
            break;
        }
        tokio::task::yield_now().await;
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(reopened, "the closed socket's place was given back");
}

#[tokio::test]
async fn an_account_opening_too_fast_is_closed_with_the_cap_code() {
    let core = fake_core(&[("student", Some("student"))]).await;
    let mut relay = relay_to(&echo_upstream().await, core);
    relay.max_new_per_window = 2;
    let url = serve(Some(relay)).await;
    assert!(admitted(&url("student")).await);
    assert!(admitted(&url("student")).await);
    assert_eq!(refused_with(&url("student")).await, Some(close_code::CAP));
}

#[tokio::test]
async fn an_account_past_its_byte_budget_is_closed_mid_connection_and_refused_after() {
    let core = fake_core(&[("student", Some("student"))]).await;
    let mut relay = relay_to(&echo_upstream().await, core);
    relay.byte_budget = 64;
    let url = serve(Some(relay)).await;
    let mut socket = open(&url("student")).await.unwrap();
    socket
        .send(WsMessage::Binary(vec![0u8; 100].into()))
        .await
        .unwrap();
    assert_eq!(
        next_binary_or_close(&mut socket).await,
        Err(Some(close_code::CAP))
    );
    // The budget is the ACCOUNT's: a new connection does not reset it.
    assert_eq!(refused_with(&url("student")).await, Some(close_code::CAP));
}

#[tokio::test]
async fn a_connection_past_its_byte_cap_ends_with_its_code() {
    let core = fake_core(&[("student", Some("student"))]).await;
    let mut relay = relay_to(&echo_upstream().await, core);
    relay.max_bytes = 64;
    let url = serve(Some(relay)).await;
    let mut socket = open(&url("student")).await.unwrap();
    socket
        .send(WsMessage::Binary(vec![0u8; 100].into()))
        .await
        .unwrap();
    assert_eq!(
        next_binary_or_close(&mut socket).await,
        Err(Some(close_code::BYTE_CAP))
    );
}

#[tokio::test]
async fn a_text_frame_ends_the_connection_as_a_protocol_fault() {
    let core = fake_core(&[("student", Some("student"))]).await;
    let url = serve(Some(relay_to(&echo_upstream().await, core))).await;
    let mut socket = open(&url("student")).await.unwrap();
    socket.send(WsMessage::Text("hello".into())).await.unwrap();
    assert_eq!(
        next_binary_or_close(&mut socket).await,
        Err(Some(close_code::PROTOCOL))
    );
}

#[tokio::test]
async fn the_upstream_closing_ends_the_socket_with_its_code() {
    // An upstream that accepts and closes at once.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    tokio::spawn(async move {
        while let Ok((socket, _)) = listener.accept().await {
            drop(socket);
        }
    });
    let core = fake_core(&[("student", Some("student"))]).await;
    let url = serve(Some(relay_to(&addr, core))).await;
    let mut socket = open(&url("student")).await.unwrap();
    assert_eq!(
        next_binary_or_close(&mut socket).await,
        Err(Some(close_code::UPSTREAM_CLOSED))
    );
}

#[tokio::test]
async fn an_upstream_that_refuses_the_connect_is_a_502() {
    // Bound, then dropped: nothing listens on this port any more.
    let addr = {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        listener.local_addr().unwrap().to_string()
    };
    let core = fake_core(&[("student", Some("student"))]).await;
    let url = serve(Some(relay_to(&addr, core))).await;
    assert_eq!(
        open(&url("student")).await.err(),
        Some(StatusCode::BAD_GATEWAY)
    );
}

#[tokio::test]
async fn an_idle_connection_ends_with_its_own_code_before_nginx_would() {
    // Below every hop that cuts a silent connection, with a margin: the Cloudflare edge's 100 s
    // and nginx's 120 s (`proxy_read_timeout`, also held by mail-relay-route.test.mjs).
    assert!(
        IDLE_DEADLINE + Duration::from_secs(10) <= Duration::from_secs(100),
        "clearly below the Cloudflare edge's 100 s idle bound"
    );
    let core = fake_core(&[("student", Some("student"))]).await;
    let mut relay = relay_to(&echo_upstream().await, core);
    relay.idle = Duration::from_millis(200);
    let url = serve(Some(relay)).await;
    let mut socket = open(&url("student")).await.unwrap();
    // Traffic moves the deadline on: the echo comes back, then nothing crosses.
    socket
        .send(WsMessage::Binary(vec![1u8; 8].into()))
        .await
        .unwrap();
    assert_eq!(next_binary_or_close(&mut socket).await, Ok(vec![1u8; 8]));
    assert_eq!(
        next_binary_or_close(&mut socket).await,
        Err(Some(close_code::IDLE))
    );
}
