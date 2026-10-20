//! Happy Eyeballs (RFC 8305) TCP connect for the native chat WebSocket.
//!
//! WHY (CALL-WS-V6, 2026-10-20, docs/wiki/frontend/mobile.md#the-native-socket-races-ipv6-and-ipv4):
//! `tauri-plugin-websocket` connected through `tokio-tungstenite`, whose `TcpStream::connect`
//! tries the resolved addresses ONE AFTER ANOTHER and waits for each to fail. On a Wi-Fi that hands
//! out IPv6 addresses but carries no IPv6 traffic, the IPv6 attempt hangs for the OS connect
//! timeout (20-21 s on the Mi 9T) before IPv4 is tried, so every chat-socket attempt outlived the
//! page's 15 s deadline and the phone received no live frame and no call invite. The HTTP stack
//! (reqwest / hyper-util) already races the two families and worked on the same network.
//!
//! The fix is at the connect itself: the addresses are interleaved by family and attempts start
//! [`CONNECTION_ATTEMPT_DELAY`] apart (or at once when the previous one fails), the first to
//! connect wins and the others are dropped. A win by anything but the first address is the
//! signal that the preferred path is broken, so it is logged at WARN with every attempt it beat.

use std::future::Future;
use std::io;
use std::net::SocketAddr;
use std::time::Duration;

use tokio::net::TcpStream;
use tokio::task::JoinSet;
use tokio::time::Instant;

/// RFC 8305 section 5: the recommended delay before the next attempt starts while the previous
/// one is still pending. hyper-util, behind the app's HTTP client, waits 300 ms.
pub(crate) const CONNECTION_ATTEMPT_DELAY: Duration = Duration::from_millis(250);

/// One attempt that did not win the race.
#[derive(Debug)]
pub(crate) struct LostAttempt {
    pub addr: SocketAddr,
    /// `Some` when the attempt failed before the winner connected, `None` when it was still
    /// pending and was dropped.
    pub error: Option<String>,
}

/// What a won race looked like: who won, when, and every attempt it beat.
#[derive(Debug)]
pub(crate) struct RaceReport {
    pub winner: SocketAddr,
    /// Position of the winner in the interleaved order; 0 means the preferred address won.
    pub winner_rank: usize,
    pub elapsed: Duration,
    pub lost: Vec<LostAttempt>,
}

/// Orders addresses per RFC 8305 section 4: the family of the first resolved address leads, and
/// the two families alternate from there, each keeping the resolver's own order.
pub(crate) fn interleave(addrs: Vec<SocketAddr>) -> Vec<SocketAddr> {
    let Some(first) = addrs.first() else {
        return addrs;
    };
    let first_is_v6 = first.is_ipv6();
    let (preferred, other): (Vec<_>, Vec<_>) =
        addrs.into_iter().partition(|a| a.is_ipv6() == first_is_v6);
    let mut out = Vec::with_capacity(preferred.len() + other.len());
    let mut p = preferred.into_iter();
    let mut o = other.into_iter();
    loop {
        match (p.next(), o.next()) {
            (None, None) => break,
            (a, b) => out.extend(a.into_iter().chain(b)),
        }
    }
    out
}

/// Races `connect` over `addrs` (already interleaved): attempt N+1 starts `delay` after attempt N,
/// or at once when every running attempt has failed. The first success wins and every attempt still
/// running is aborted - dropping its future closes its socket. Fails only when every address failed.
///
/// `connect` is injected so the race is tested without a network and on tokio's paused clock.
pub(crate) async fn race<T, F, Fut>(
    addrs: &[SocketAddr],
    delay: Duration,
    connect: F,
) -> io::Result<(T, RaceReport)>
where
    T: Send + 'static,
    F: Fn(SocketAddr) -> Fut,
    Fut: Future<Output = io::Result<T>> + Send + 'static,
{
    if addrs.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "no address to connect to",
        ));
    }
    let started = Instant::now();
    let mut running: JoinSet<(usize, io::Result<T>)> = JoinSet::new();
    let mut failed: Vec<(usize, String)> = Vec::new();
    let mut next = 0usize;

    loop {
        // Start the next attempt.
        let rank = next;
        let fut = connect(addrs[rank]);
        running.spawn(async move { (rank, fut.await) });
        next += 1;

        // Wait for a result, or for the stagger delay when an address is still unstarted.
        let stagger = tokio::time::sleep(delay);
        tokio::pin!(stagger);
        loop {
            tokio::select! {
                joined = running.join_next() => {
                    let Some(joined) = joined else {
                        // Nothing running: every started attempt failed.
                        if next < addrs.len() {
                            break;
                        }
                        return Err(all_failed(addrs, &failed));
                    };
                    let (rank, result) = joined.map_err(|e| {
                        io::Error::other(format!("connect attempt task failed: {e}"))
                    })?;
                    match result {
                        Ok(stream) => {
                            let lost = lost_attempts(addrs, rank, next, failed);
                            // Dropping the set aborts every attempt still running.
                            running.abort_all();
                            return Ok((
                                stream,
                                RaceReport {
                                    winner: addrs[rank],
                                    winner_rank: rank,
                                    elapsed: started.elapsed(),
                                    lost,
                                },
                            ));
                        }
                        Err(e) => {
                            failed.push((rank, e.to_string()));
                            // RFC 8305 section 5: a failure starts the next attempt without
                            // waiting out the delay.
                            if next < addrs.len() {
                                break;
                            }
                        }
                    }
                }
                _ = &mut stagger, if next < addrs.len() => break,
            }
        }
    }
}

/// Every started attempt except the winner: failed ones carry their error, the rest were pending.
fn lost_attempts(
    addrs: &[SocketAddr],
    winner: usize,
    started: usize,
    failed: Vec<(usize, String)>,
) -> Vec<LostAttempt> {
    (0..started)
        .filter(|&r| r != winner)
        .map(|r| LostAttempt {
            addr: addrs[r],
            error: failed
                .iter()
                .find(|(fr, _)| *fr == r)
                .map(|(_, e)| e.clone()),
        })
        .collect()
}

fn all_failed(addrs: &[SocketAddr], failed: &[(usize, String)]) -> io::Error {
    let detail = failed
        .iter()
        .map(|(r, e)| format!("{}: {e}", addrs[*r]))
        .collect::<Vec<_>>()
        .join("; ");
    io::Error::new(
        io::ErrorKind::ConnectionRefused,
        format!("every address failed ({detail})"),
    )
}

/// Whether a won race is a signal: the preferred (first) address lost, so the network's preferred
/// path is broken - an IPv6 that is handed out and not routed, typically.
pub(crate) fn is_degraded(report: &RaceReport) -> bool {
    report.winner_rank != 0
}

/// Resolves `host` and connects to it with [`race`]: the TCP connect `tauri-plugin-websocket`
/// (patched, `patches/tauri-plugin-websocket`) runs before its TLS and WebSocket handshakes.
pub(crate) async fn connect(host: String, port: u16) -> io::Result<TcpStream> {
    log::debug!("[WS-NET] connect {host}:{port}");
    let resolved: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), port))
        .await
        .map_err(|e| {
            log::error!("[WS-NET] {host}:{port} did not resolve: {e}");
            e
        })?
        .collect();
    let addrs = interleave(resolved);
    log::debug!("[WS-NET] {host}:{port} racing {addrs:?}");
    match race(&addrs, CONNECTION_ATTEMPT_DELAY, TcpStream::connect).await {
        Ok((stream, report)) => {
            if is_degraded(&report) {
                let lost = report
                    .lost
                    .iter()
                    .map(|l| match &l.error {
                        Some(e) => format!("{} failed: {e}", l.addr),
                        None => format!("{} still pending", l.addr),
                    })
                    .collect::<Vec<_>>()
                    .join("; ");
                log::warn!(
                    "[WS-NET] {host}:{port} connected through {} after {} ms, NOT the preferred address - lost: {lost}",
                    report.winner,
                    report.elapsed.as_millis()
                );
            } else {
                log::debug!(
                    "[WS-NET] {host}:{port} connected through {} in {} ms",
                    report.winner,
                    report.elapsed.as_millis()
                );
            }
            Ok(stream)
        }
        Err(e) => {
            log::error!("[WS-NET] {host}:{port} could not connect: {e}");
            Err(e)
        }
    }
}

/// The connect in the shape `tauri_plugin_websocket::Builder::tcp_connector` takes.
pub(crate) fn tcp_connector() -> tauri_plugin_websocket::TcpConnectFn {
    std::sync::Arc::new(
        |host: String,
         port: u16|
         -> std::pin::Pin<Box<dyn Future<Output = io::Result<TcpStream>> + Send>> {
            Box::pin(connect(host, port))
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    fn v6(n: u16) -> SocketAddr {
        SocketAddr::new(format!("2001:db8::{n}").parse().unwrap(), 443)
    }
    fn v4(n: u8) -> SocketAddr {
        SocketAddr::new(format!("192.0.2.{n}").parse().unwrap(), 443)
    }

    /// What each address does when attempted, decided by the test.
    #[derive(Clone, Copy)]
    enum Behaviour {
        Connect,
        Refuse,
        /// A blackholed SYN: never answers, as on the CALL-WS-V6 network.
        Hang,
    }

    /// Records a drop, so a test can prove a losing attempt was cancelled rather than leaked.
    struct DropFlag(Arc<AtomicUsize>);
    impl Drop for DropFlag {
        fn drop(&mut self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }

    fn connector(
        plan: Vec<(SocketAddr, Behaviour)>,
        started: Arc<AtomicUsize>,
        dropped: Arc<AtomicUsize>,
    ) -> impl Fn(SocketAddr) -> std::pin::Pin<Box<dyn Future<Output = io::Result<SocketAddr>> + Send>>
    {
        move |addr| {
            started.fetch_add(1, Ordering::SeqCst);
            let behaviour = plan.iter().find(|(a, _)| *a == addr).unwrap().1;
            let flag = DropFlag(dropped.clone());
            Box::pin(async move {
                let _flag = flag;
                match behaviour {
                    Behaviour::Connect => Ok(addr),
                    Behaviour::Refuse => Err(io::Error::from(io::ErrorKind::ConnectionRefused)),
                    Behaviour::Hang => std::future::pending().await,
                }
            })
        }
    }

    #[test]
    fn interleave_alternates_families_starting_with_the_first() {
        let got = interleave(vec![v6(1), v6(2), v6(3), v4(1), v4(2)]);
        assert_eq!(got, vec![v6(1), v4(1), v6(2), v4(2), v6(3)]);
        let got = interleave(vec![v4(1), v6(1), v4(2)]);
        assert_eq!(got, vec![v4(1), v6(1), v4(2)]);
        assert!(interleave(vec![]).is_empty());
    }

    /// The CALL-WS-V6 network: the IPv6 address never answers, the IPv4 one does. IPv4 must be
    /// connected one stagger delay in, not after the OS connect timeout, and the hung IPv6 attempt
    /// must be dropped, not left running.
    #[tokio::test(start_paused = true)]
    async fn a_blackholed_ipv6_loses_to_ipv4_after_one_delay() {
        let started = Arc::new(AtomicUsize::new(0));
        let dropped = Arc::new(AtomicUsize::new(0));
        let addrs = interleave(vec![v6(1), v4(1)]);
        let c = connector(
            vec![(v6(1), Behaviour::Hang), (v4(1), Behaviour::Connect)],
            started.clone(),
            dropped.clone(),
        );
        let (won, report) = race(&addrs, CONNECTION_ATTEMPT_DELAY, c).await.unwrap();
        assert_eq!(won, v4(1));
        assert_eq!(report.winner_rank, 1);
        assert_eq!(report.elapsed, CONNECTION_ATTEMPT_DELAY);
        assert!(is_degraded(&report));
        assert_eq!(report.lost.len(), 1);
        assert_eq!(report.lost[0].addr, v6(1));
        assert!(
            report.lost[0].error.is_none(),
            "the IPv6 attempt was pending"
        );
        tokio::task::yield_now().await;
        assert_eq!(
            dropped.load(Ordering::SeqCst),
            2,
            "winner and loser both released"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_refused_attempt_starts_the_next_without_waiting() {
        let started = Arc::new(AtomicUsize::new(0));
        let dropped = Arc::new(AtomicUsize::new(0));
        let addrs = vec![v6(1), v4(1)];
        let c = connector(
            vec![(v6(1), Behaviour::Refuse), (v4(1), Behaviour::Connect)],
            started,
            dropped,
        );
        let (won, report) = race(&addrs, CONNECTION_ATTEMPT_DELAY, c).await.unwrap();
        assert_eq!(won, v4(1));
        assert_eq!(report.elapsed, Duration::ZERO);
        assert!(report.lost[0].error.is_some());
    }

    #[tokio::test(start_paused = true)]
    async fn a_working_first_address_is_the_only_attempt() {
        let started = Arc::new(AtomicUsize::new(0));
        let dropped = Arc::new(AtomicUsize::new(0));
        let addrs = vec![v6(1), v4(1)];
        let c = connector(
            vec![(v6(1), Behaviour::Connect), (v4(1), Behaviour::Connect)],
            started.clone(),
            dropped,
        );
        let (won, report) = race(&addrs, CONNECTION_ATTEMPT_DELAY, c).await.unwrap();
        assert_eq!(won, v6(1));
        assert!(!is_degraded(&report));
        assert!(report.lost.is_empty());
        assert_eq!(started.load(Ordering::SeqCst), 1);
    }

    /// A staggered start never cancels an attempt still running: with both families hanging, the
    /// IPv4 attempt starts at one delay and the IPv6 one may still win afterwards.
    #[tokio::test(start_paused = true)]
    async fn a_slow_first_attempt_still_wins_after_the_next_has_started() {
        let started = Arc::new(AtomicUsize::new(0));
        let addrs = vec![v6(1), v4(1)];
        let c = {
            let started = started.clone();
            move |addr: SocketAddr| {
                started.fetch_add(1, Ordering::SeqCst);
                Box::pin(async move {
                    if addr.is_ipv6() {
                        tokio::time::sleep(Duration::from_millis(400)).await;
                        Ok(addr)
                    } else {
                        std::future::pending().await
                    }
                })
                    as std::pin::Pin<Box<dyn Future<Output = io::Result<SocketAddr>> + Send>>
            }
        };
        let (won, report) = race(&addrs, CONNECTION_ATTEMPT_DELAY, c).await.unwrap();
        assert_eq!(won, v6(1));
        assert_eq!(report.elapsed, Duration::from_millis(400));
        assert!(!is_degraded(&report));
        assert_eq!(started.load(Ordering::SeqCst), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn every_address_failing_is_one_error_naming_each() {
        let started = Arc::new(AtomicUsize::new(0));
        let dropped = Arc::new(AtomicUsize::new(0));
        let addrs = vec![v6(1), v4(1), v6(2)];
        let c = connector(
            vec![
                (v6(1), Behaviour::Refuse),
                (v4(1), Behaviour::Refuse),
                (v6(2), Behaviour::Refuse),
            ],
            started.clone(),
            dropped,
        );
        let err = race(&addrs, CONNECTION_ATTEMPT_DELAY, c).await.unwrap_err();
        let text = err.to_string();
        for a in &addrs {
            assert!(text.contains(&a.to_string()), "{text} names {a}");
        }
        assert_eq!(started.load(Ordering::SeqCst), 3);
    }

    /// The real path, resolver and sockets included, against a listener on loopback.
    #[tokio::test]
    async fn connect_reaches_a_local_listener() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let stream = tcp_connector()("127.0.0.1".to_string(), port)
            .await
            .unwrap();
        assert_eq!(stream.peer_addr().unwrap(), listener.local_addr().unwrap());
    }

    #[tokio::test(start_paused = true)]
    async fn no_address_is_an_error() {
        let c = connector(vec![], Arc::default(), Arc::default());
        assert!(race(&[], CONNECTION_ATTEMPT_DELAY, c).await.is_err());
    }
}
