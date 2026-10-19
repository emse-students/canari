/**
 * THE CLIENT'S v1 LIVE PARAMETERS - what the broadcaster asks of `MediaRecorder` and how a viewer
 * polls and buffers. Measured on the WP-L1 bench (2026-10-19, Mi 9T app WebView, iPhone 12 Safari,
 * PC Chrome, through the dev ingest): docs/wiki/frontend/modules/live.md, "WP-L1 - measured"
 * (written up by PR #2109), and "The client foundation" there for what this module holds.
 *
 * NOT HERE: every number the SERVER enforces (segment size, reconnect window, longest live, seat
 * lease, viewer cap...). Those are read from `GET /api/lives/limits` at run time (`fetchLiveLimits`),
 * because an installed build keeps whatever it was compiled with.
 */

/**
 * Capture size, the long side, in pixels: 720p, ONE tier. 480p saved only 16 % of the Android
 * uplink (3.08 -> 2.59 Mb/s: the encoder floors at ~2.6 Mb/s with 2 s keyframes) and bought no
 * latency (WP-L1 run C). The short side follows the camera's aspect.
 */
export const LIVE_CAPTURE_LONG_SIDE_PX = 1280;

/** The short side of {@link LIVE_CAPTURE_LONG_SIDE_PX}'s 16:9 frame. */
export const LIVE_CAPTURE_SHORT_SIDE_PX = 720;

/** Frames per second asked of the camera (both phones delivered 30 in WP-L1). */
export const LIVE_CAPTURE_FPS = 30;

/**
 * The bitrate ASKED of `MediaRecorder` (`videoBitsPerSecond`): 2.0 Mb/s. A 720p request under
 * 2.5 Mb/s already lands on the Android encoder's ~2.6 Mb/s floor, so asking less changes nothing
 * there while keeping the iPhone (which honours its target: 2.32 Mb/s for 2.5) lower (WP-L1).
 */
export const LIVE_REQUESTED_VIDEO_BPS = 2_000_000;

/**
 * Segment length = `MediaRecorder` timeslice, in ms: 2 s. 1 s saved about a second of latency but
 * doubled the requests and stalled twice as often; 4 s was worse on every column (WP-L1 run C).
 */
export const LIVE_SEGMENT_MS = 2_000;

/**
 * Keyframe interval (`videoKeyFrameIntervalDuration`), in ms: equal to the segment, so every
 * segment starts on a keyframe and a viewer can join at the newest one (567/567 and 657/657
 * segments keyframe-aligned in WP-L1).
 */
export const LIVE_KEYFRAME_INTERVAL_MS = LIVE_SEGMENT_MS;

/**
 * The container asked of `MediaRecorder`, the string BOTH engines produced in WP-L1 (H.264
 * baseline + AAC-LC in fragmented MP4) - and the type a viewer checks with `isTypeSupported`.
 */
export const LIVE_RECORDER_MIME = 'video/mp4;codecs=avc1.42E01F,mp4a.40.2';

/**
 * How far behind its buffer's end a viewer's player aims to sit, in ms: about ONE segment. The
 * bench's 1 s target starved at 4 s segments and drifted to 3 s behind at 2 s; past a gap
 * (a background, a lost network) the player SEEKS to the live edge rather than replaying the gap.
 */
export const LIVE_PLAYER_TARGET_BUFFER_MS = LIVE_SEGMENT_MS;

/**
 * How often a viewer polls the manifest, in ms. The bench polled every 500 ms (half a poll = 0.25 s
 * of the 6-7 s glass-to-glass); 1 s - half a segment - costs ~0.25 s more and HALVES the manifest
 * load, which is social-service work per viewer (the watch rule's SQL plus the seat's Redis script)
 * on a shared 4-vCPU host. Ten polls fit in the 30 s seat lease many times over. A choice, not a
 * measurement: re-read it against social-service's CPU on the first many-viewer run.
 */
export const LIVE_MANIFEST_POLL_MS = 1_000;

/**
 * Below this battery level (0..1) the pre-live screen warns, where the engine has the Battery API
 * (Android's WebView; WebKit has none). The Mi 9T broadcasting drained ~40 %/h WHILE PLUGGED into a
 * 400 mA port (WP-L1 run A), and ~59 %/h unplugged without the upload (2026-10-18) - so an hour's
 * live from 60 % is about where a phone runs out.
 */
export const LIVE_BATTERY_WARN_LEVEL = 0.6;

/**
 * How long a stopping recorder may take to hand over its last chunk. A healthy one answers within
 * one timeslice; one that never fires `stop` must not hold the camera, the screen lock or the next
 * recorder - so past this the wait is abandoned, LOGGED, and whatever it still held is lost.
 */
export const LIVE_RECORDER_STOP_BOUND_MS = LIVE_SEGMENT_MS + 1_000;

/**
 * Segments waiting for the server beyond the reconnect window's worth: the broadcaster gives up
 * there, and the CAUSE is read from the last segment the server STORED, not from the count. Silent
 * past `reconnectWindowMs` is a lost connection - the server ends a live absent that long anyway. Still
 * storing is an uplink slower than real time: the queue grows by the difference (at 80 % of real time,
 * past the cap in ~6 min), viewers fall further behind every minute, and memory grows ~23 MB a minute
 * of backlog - so the live ends saying the upload is too slow, never that the connection was lost.
 * The margin absorbs a slow link's ordinary jitter.
 */
export const LIVE_BACKLOG_MARGIN_SEGMENTS = 5;

/**
 * The planning figure for ONE viewer's egress, in bits per second: the Android broadcaster's
 * measured mean (3.08 Mb/s, the heavier of the two engines; iPhone 2.32 Mb/s). For estimates only -
 * the cap itself is the server's (`viewerCap` in `/limits`).
 */
export const LIVE_PLANNING_VIEWER_BPS = 3_100_000;

/**
 * How far behind its buffer's end the viewer may drift before it SEEKS back to the live edge, in ms:
 * three segments. The bench seeked at 6 s behind with 2 s segments and kept glass-to-glass at
 * 5.8-7.3 s p50 (WP-L1); one stall or a slow segment fetch costs ~one segment, so a smaller bound
 * would seek on ordinary jitter.
 */
export const LIVE_PLAYER_MAX_BEHIND_MS = 3 * LIVE_SEGMENT_MS;

/**
 * How many NEW segments one manifest may bring before the viewer skips to the newest instead of
 * playing them all: more than two means it fell behind (a background, a lost network, a slow link),
 * and catching up by playing the backlog would keep it behind for good.
 */
export const LIVE_PLAYER_CATCHUP_SEGMENTS = 2;

/**
 * How long the broadcaster may go without a stored segment before the viewer says "reconnecting",
 * in ms: three segments. Read from the manifest's `serverNow - lastSegmentAt`, both the database's
 * clock - never the device's. The live itself ends on the SERVER's 60 s window, never on this.
 */
export const LIVE_BROADCASTER_QUIET_MS = 3 * LIVE_SEGMENT_MS;

/** How much played media the viewer keeps behind its position, in ms, before trimming the buffer. */
export const LIVE_PLAYER_KEEP_BEHIND_MS = 10_000;
