// What one connection sent, said once when it ends.
//
// The gateway logs each data frame as it arrives, and nothing says what a whole connection sent:
// how many frames, how large the largest, how many in its busiest minute. Those three numbers are
// what a per-connection limit has to sit above, and they can only be read from the gateway (the
// delivery queue holds what is still stored, a sample of what was accepted).
//
// So each connection carries a [`FrameCensus`], fed by the receive loop, and its `Drop` writes ONE
// line - `[WS FRAMES]` - whichever way the connection ends: a close frame, a reset, the sender half
// ending first (which aborts the receive task and drops what it owns). It changes nothing a client
// sees: it counts, and refuses nothing.
//
// THE CLOCK ONLY NAMES THE MINUTE. A minute here is a fixed window counted from the open, so a burst
// that straddles two windows is split between them: the true count over ANY sixty seconds is at
// most twice the peak written. A limit sized from this line takes that factor into account.

use std::time::{Duration, Instant};

/// The window `peak_per_minute` is counted over.
const WINDOW: Duration = Duration::from_secs(60);

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
    /// The most frames in one fixed minute of the connection (see the header for what that bounds).
    pub peak_per_minute: u64,
    /// The window the next frame is compared to, as a count of [`WINDOW`]s since the open.
    window: u64,
    /// Frames in that window so far.
    in_window: u64,
}

impl FrameCounts {
    /// Counts one inbound text frame of `len` bytes, received `since_open` after the open.
    pub fn note(&mut self, len: usize, since_open: Duration) {
        let window = since_open.as_secs() / WINDOW.as_secs();
        if window != self.window {
            self.window = window;
            self.in_window = 0;
        }
        self.in_window += 1;
        self.peak_per_minute = self.peak_per_minute.max(self.in_window);
        self.frames += 1;
        self.bytes += len as u64;
        self.largest = self.largest.max(len);
    }

    /// Says the frame just counted was an application heartbeat.
    pub fn heartbeat(&mut self) {
        self.heartbeats += 1;
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

    /// Counts one inbound text frame of `len` bytes, received now.
    pub fn note(&mut self, len: usize) {
        self.counts.note(len, self.opened.elapsed());
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
    use super::{FrameCensus, FrameCounts};
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
}
