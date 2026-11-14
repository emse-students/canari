// What one connection sent, said once when it ends.
//
// The gateway logs each data frame as it arrives, and nothing says what a whole connection sent:
// how many frames, how large the largest, how many in its busiest minute. Those three numbers are
// what a per-connection limit has to sit above, and they can only be read from the gateway (the
// delivery queue holds what is still stored, a sample of what was accepted).
//
// So each connection carries a [`FrameCensus`], fed by the receive loop, and its `Drop` writes ONE
// line - `[WS FRAMES]` - whichever way the connection ends: a close frame, a reset, the sender half
// ending first (which aborts the receive task and drops what it owns). The census itself counts
// and refuses nothing; [`FrameLimits`] is what the receive loop compares its counts to.
//
// THE CLOCK ONLY NAMES THE MINUTE. A minute here is a fixed window counted from the open, so a burst
// that straddles two windows is split between them: the true count over ANY sixty seconds is at
// most twice the peak written. A limit sized from this line takes that factor into account.

use std::time::{Duration, Instant};

/// The window `peak_per_minute` is counted over.
const WINDOW: Duration = Duration::from_secs(60);

/// The largest inbound frame a connection may send, in bytes, unless `WS_MAX_FRAME_BYTES` says
/// otherwise. The socket carries three client frames - the heartbeat, `typing`, `disconnect` -
/// and the longest is a `typing` naming its conversation; messages travel over HTTP. Production
/// read 82 bytes as the largest of 389 connections (2026-11-14), so this sits fifty times above
/// what any client sends.
pub const DEFAULT_MAX_FRAME_BYTES: usize = 4_096;

/// The most inbound frames a connection may send in one fixed minute, unless
/// `WS_MAX_FRAMES_PER_MINUTE` says otherwise. Production's busiest minute of those 389 connections
/// was 21 frames, which bounds any sixty seconds at 42 (see the header): this is over five times
/// that.
pub const DEFAULT_MAX_FRAMES_PER_MINUTE: u64 = 240;

/// The lowest value `WS_MAX_FRAME_BYTES` may hold. Under the heartbeat's own length every client
/// would be ended at each heartbeat and reconnect at once - the whole estate, every few seconds -
/// so a value under this is a mistake, refused like a zero.
pub const MIN_MAX_FRAME_BYTES: u64 = 256;

/// The lowest value `WS_MAX_FRAMES_PER_MINUTE` may hold, for the same reason: a heartbeat every
/// 8 s and a typing signal every 3 s are about 28 frames a minute from one ordinary client.
pub const MIN_MAX_FRAMES_PER_MINUTE: u64 = 60;

/// What one connection may send. Past either bound the gateway says so once (`[WS LIMIT]`) and
/// ends the socket, so the client reconnects on its own delay.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FrameLimits {
    /// The largest inbound frame, in bytes; a longer one is refused by the socket itself, before
    /// it is buffered.
    pub max_frame_bytes: usize,
    /// The most inbound frames in one fixed minute of a connection.
    pub max_frames_per_minute: u64,
}

impl Default for FrameLimits {
    fn default() -> Self {
        Self {
            max_frame_bytes: DEFAULT_MAX_FRAME_BYTES,
            max_frames_per_minute: DEFAULT_MAX_FRAMES_PER_MINUTE,
        }
    }
}

/// Why a configured limit was not used.
#[derive(Debug, PartialEq, Eq)]
pub struct UnusableLimit {
    /// The variable that held it.
    pub name: &'static str,
    /// What it held.
    pub raw: String,
    /// The lowest value it may hold.
    pub min: u64,
}

/// Reads one limit: absent means the default, an integer from `min` up that fits this machine's
/// sizes means itself, and anything else is refused by name so the caller can say it.
fn limit_from(
    name: &'static str,
    raw: Option<&str>,
    min: u64,
    default: u64,
) -> Result<u64, UnusableLimit> {
    let Some(raw) = raw.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(default);
    };
    match raw.parse::<u64>() {
        Ok(value) if value >= min && usize::try_from(value).is_ok() => Ok(value),
        _ => Err(UnusableLimit {
            name,
            raw: raw.to_string(),
            min,
        }),
    }
}

impl FrameLimits {
    /// The limits two environment values describe (`WS_MAX_FRAME_BYTES`,
    /// `WS_MAX_FRAMES_PER_MINUTE`), and every value that could not be used - its limit is then the
    /// default, and the caller logs the refusal.
    pub fn from_values(
        max_frame_bytes: Option<&str>,
        max_frames_per_minute: Option<&str>,
    ) -> (Self, Vec<UnusableLimit>) {
        let mut unusable = Vec::new();
        let mut read = |name, raw, min, default| {
            limit_from(name, raw, min, default).unwrap_or_else(|refused| {
                unusable.push(refused);
                default
            })
        };
        let bytes = read(
            "WS_MAX_FRAME_BYTES",
            max_frame_bytes,
            MIN_MAX_FRAME_BYTES,
            DEFAULT_MAX_FRAME_BYTES as u64,
        );
        let per_minute = read(
            "WS_MAX_FRAMES_PER_MINUTE",
            max_frames_per_minute,
            MIN_MAX_FRAMES_PER_MINUTE,
            DEFAULT_MAX_FRAMES_PER_MINUTE,
        );
        let limits = Self {
            // `limit_from` refused what does not fit, and the default fits.
            max_frame_bytes: usize::try_from(bytes).unwrap_or(DEFAULT_MAX_FRAME_BYTES),
            max_frames_per_minute: per_minute,
        };
        (limits, unusable)
    }
}

/// The counts of one connection's inbound text frames.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct FrameCounts {
    /// Every inbound text frame, the application heartbeats among them.
    pub frames: u64,
    /// The application heartbeats (`{"type":"ping"}`) among `frames`.
    pub heartbeats: u64,
    /// Bytes of every inbound text frame, as received.
    pub bytes: u64,
    /// The largest inbound text frame, in bytes.
    pub largest: usize,
    /// The most frames of ANY kind in one fixed minute of the connection (see the header for what
    /// that bounds): the text frames, and the binary, ping and pong frames [`Self::note_other`]
    /// counts.
    pub peak_per_minute: u64,
    /// The window the next frame is compared to, as a count of [`WINDOW`]s since the open.
    window: u64,
    /// Frames in that window so far.
    in_window: u64,
}

impl FrameCounts {
    /// Counts one inbound text frame of `len` bytes, received `since_open` after the open.
    pub fn note(&mut self, len: usize, since_open: Duration) {
        self.note_other(since_open);
        self.frames += 1;
        self.bytes += len as u64;
        self.largest = self.largest.max(len);
    }

    /// Counts one inbound frame that is not text - binary, ping or pong - toward its minute and
    /// nothing else: no client sends one unasked, and each still costs the gateway its work.
    pub fn note_other(&mut self, since_open: Duration) {
        let window = since_open.as_secs() / WINDOW.as_secs();
        if window != self.window {
            self.window = window;
            self.in_window = 0;
        }
        self.in_window += 1;
        self.peak_per_minute = self.peak_per_minute.max(self.in_window);
    }

    /// Says the frame just counted was an application heartbeat.
    pub fn heartbeat(&mut self) {
        self.heartbeats += 1;
    }

    /// Frames counted in the window of the last one: what a per-minute limit is compared to.
    pub fn in_window(&self) -> u64 {
        self.in_window
    }
}

/// One connection's [`FrameCounts`], written as a single line when the connection ends.
pub struct FrameCensus {
    user_id: String,
    device_id: String,
    opened: Instant,
    counts: FrameCounts,
}

impl FrameCensus {
    /// Starts counting for the connection of `user_id:device_id`, opened now.
    pub fn open(user_id: &str, device_id: &str) -> Self {
        Self {
            user_id: user_id.to_string(),
            device_id: device_id.to_string(),
            opened: Instant::now(),
            counts: FrameCounts::default(),
        }
    }

    /// Counts one inbound text frame of `len` bytes, received now, and returns how many frames
    /// its minute now holds.
    pub fn note(&mut self, len: usize) -> u64 {
        self.counts.note(len, self.opened.elapsed());
        self.counts.in_window()
    }

    /// Counts one inbound frame that is not text, received now, and returns how many frames its
    /// minute now holds.
    pub fn note_other(&mut self) -> u64 {
        self.counts.note_other(self.opened.elapsed());
        self.counts.in_window()
    }

    /// Says the frame just counted was an application heartbeat.
    pub fn heartbeat(&mut self) {
        self.counts.heartbeat();
    }

    /// The line written at the end of the connection.
    fn line(&self, lasted: Duration) -> String {
        let c = &self.counts;
        format!(
            "[WS FRAMES] {}:{} closed after {}s: frames={} heartbeats={} bytes={} largest={} peakPerMinute={}",
            self.user_id,
            self.device_id,
            lasted.as_secs(),
            c.frames,
            c.heartbeats,
            c.bytes,
            c.largest,
            c.peak_per_minute
        )
    }
}

impl Drop for FrameCensus {
    fn drop(&mut self) {
        tracing::info!("{}", self.line(self.opened.elapsed()));
    }
}

#[cfg(test)]
mod tests {
    use super::{FrameCensus, FrameCounts, FrameLimits, UnusableLimit};
    use std::time::Duration;

    fn at(seconds: u64) -> Duration {
        Duration::from_secs(seconds)
    }

    #[test]
    fn a_connection_that_sent_nothing_counts_nothing() {
        assert_eq!(FrameCounts::default().frames, 0);
        assert_eq!(FrameCounts::default().peak_per_minute, 0);
    }

    #[test]
    fn every_frame_is_counted_with_its_bytes_and_the_largest_is_kept() {
        let mut counts = FrameCounts::default();
        counts.note(100, at(1));
        counts.note(4_000, at(2));
        counts.note(15, at(3));
        counts.heartbeat();

        assert_eq!(counts.frames, 3);
        assert_eq!(counts.heartbeats, 1);
        assert_eq!(counts.bytes, 4_115);
        assert_eq!(counts.largest, 4_000);
    }

    #[test]
    fn the_peak_is_the_busiest_fixed_minute_not_the_last_one() {
        let mut counts = FrameCounts::default();
        // Minute 0: two frames. Minute 1: five. Minute 7: one.
        for second in [0, 59] {
            counts.note(1, at(second));
        }
        for second in [60, 61, 62, 90, 119] {
            counts.note(1, at(second));
        }
        counts.note(1, at(7 * 60 + 5));

        assert_eq!(counts.peak_per_minute, 5);
        assert_eq!(counts.frames, 8);
    }

    #[test]
    fn a_burst_across_two_windows_reads_as_at_least_half_of_it() {
        // Ten frames in two seconds, split 4 and 6 by the window boundary: the header's factor of
        // two is this case.
        let mut counts = FrameCounts::default();
        for _ in 0..4 {
            counts.note(1, at(59));
        }
        for _ in 0..6 {
            counts.note(1, at(60));
        }

        assert_eq!(counts.peak_per_minute, 6);
        assert!(counts.peak_per_minute * 2 >= counts.frames);
    }

    #[test]
    fn the_line_names_the_connection_and_its_five_counts_once() {
        let mut census = FrameCensus::open("user-1", "device-1");
        census.counts.note(120, at(1));
        census.counts.note(15, at(2));
        census.counts.heartbeat();

        assert_eq!(
            census.line(at(75)),
            "[WS FRAMES] user-1:device-1 closed after 75s: frames=2 heartbeats=1 bytes=135 largest=120 peakPerMinute=2"
        );
    }

    #[test]
    fn the_window_count_starts_again_with_each_minute() {
        let mut counts = FrameCounts::default();
        for _ in 0..3 {
            counts.note(1, at(10));
        }
        assert_eq!(counts.in_window(), 3);
        counts.note(1, at(60));
        assert_eq!(counts.in_window(), 1);
        assert_eq!(counts.peak_per_minute, 3);
    }

    #[test]
    fn absent_or_blank_values_are_the_defaults_and_refuse_nothing() {
        assert_eq!(
            FrameLimits::from_values(None, Some("  ")),
            (FrameLimits::default(), vec![])
        );
    }

    #[test]
    fn a_positive_value_is_the_limit() {
        let (limits, unusable) = FrameLimits::from_values(Some("8192"), Some(" 600 "));
        assert_eq!(limits.max_frame_bytes, 8_192);
        assert_eq!(limits.max_frames_per_minute, 600);
        assert!(unusable.is_empty());
    }

    #[test]
    fn a_frame_that_is_not_text_counts_toward_the_minute_and_nothing_else() {
        let mut counts = FrameCounts::default();
        counts.note(15, at(1));
        counts.note_other(at(2));
        counts.note_other(at(3));

        assert_eq!(counts.in_window(), 3);
        assert_eq!(counts.peak_per_minute, 3);
        assert_eq!(counts.frames, 1);
        assert_eq!(counts.bytes, 15);
    }

    #[test]
    fn a_value_under_the_floor_is_refused_like_a_zero() {
        // 10 bytes is under the heartbeat's own length: every client would be ended at each one.
        let (limits, unusable) = FrameLimits::from_values(Some("10"), Some("59"));
        assert_eq!(limits, FrameLimits::default());
        assert_eq!(unusable.len(), 2);
        assert_eq!(unusable[0].min, 256);
        assert_eq!(unusable[1].min, 60);

        let (limits, unusable) = FrameLimits::from_values(Some("256"), Some("60"));
        assert_eq!(limits.max_frame_bytes, 256);
        assert_eq!(limits.max_frames_per_minute, 60);
        assert!(unusable.is_empty());
    }

    #[test]
    fn zero_or_text_is_refused_by_name_and_the_default_stands() {
        let (limits, unusable) = FrameLimits::from_values(Some("0"), Some("many"));
        assert_eq!(limits, FrameLimits::default());
        assert_eq!(
            unusable,
            vec![
                UnusableLimit {
                    name: "WS_MAX_FRAME_BYTES",
                    raw: "0".to_string(),
                    min: 256
                },
                UnusableLimit {
                    name: "WS_MAX_FRAMES_PER_MINUTE",
                    raw: "many".to_string(),
                    min: 60
                },
            ]
        );
    }
}
