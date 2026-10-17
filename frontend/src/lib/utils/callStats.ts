/**
 * Reading a call's `getStats()` into the one line its log needs.
 *
 * WHY IT EXISTS. A 1:1 call goes peer to peer since 2026-10-17, with Cloudflare TURN as the last
 * resort - and which of the two a call actually used is invisible from both ends unless it is
 * written down. It decides cost (only relayed calls are billed) and it is the first question of
 * any "the call connected but sounds bad" report. The server cannot answer it: ICE runs between
 * the two clients, not through `call-service`. This is the `pair=` field of the revival plan's
 * `[CALL_REPORT]` (calls-revival-plan section 6), taken once, at connection.
 *
 * The line carries candidate TYPES and transports only - never an address, which the in-app log
 * would export.
 */

/** The subset of an `RTCStatsReport` entry this reader looks at. */
type StatsEntry = {
  type: string;
  id: string;
  /** Milliseconds, on the browser's own stats clock - the only clock a rate is computed from. */
  timestamp?: number;
  selectedCandidatePairId?: string;
  selected?: boolean;
  nominated?: boolean;
  state?: string;
  localCandidateId?: string;
  remoteCandidateId?: string;
  currentRoundTripTime?: number;
  candidateType?: string;
  protocol?: string;
  relayProtocol?: string;
  /** Chromium: the ICE server URL a local relay candidate came from (no credential in it). */
  url?: string;
  kind?: string;
  bytesSent?: number;
  bytesReceived?: number;
  packetsLost?: number;
  packetsReceived?: number;
  /** Seconds. */
  jitter?: number;
  audioLevel?: number;
  codecId?: string;
  mimeType?: string;
};

/**
 * Describes the selected ICE candidate pair as `pair=<local>/<proto> -> <remote>/<proto>`, plus
 * the relay transport when the local side is a TURN relay and the RTT when known.
 *
 * Chromium and WebKit name the pair on the `transport` entry; Gecko marks the pair itself
 * `selected`. Both are read because both are the browser's own statement of the pair.
 *
 * @param stats The report from `RTCPeerConnection.getStats()`.
 * @returns The line, or `pair=none` when no pair has been selected.
 */
export function describeSelectedPair(stats: RTCStatsReport): string {
  const entries = new Map<string, StatsEntry>();
  stats.forEach((value: StatsEntry) => entries.set(value.id, value));

  let pair: StatsEntry | undefined;
  for (const e of entries.values()) {
    if (e.type === 'transport' && e.selectedCandidatePairId) {
      pair = entries.get(e.selectedCandidatePairId);
      break;
    }
  }
  if (!pair) {
    pair = [...entries.values()].find((e) => e.type === 'candidate-pair' && e.selected === true);
  }
  if (!pair) return 'pair=none';

  const local = pair.localCandidateId ? entries.get(pair.localCandidateId) : undefined;
  const remote = pair.remoteCandidateId ? entries.get(pair.remoteCandidateId) : undefined;
  const side = (c: StatsEntry | undefined) => `${c?.candidateType ?? '?'}/${c?.protocol ?? '?'}`;
  const relayed = local?.candidateType === 'relay' || remote?.candidateType === 'relay';
  const parts = [`pair=${side(local)}->${side(remote)}`, `relayed=${relayed ? 'yes' : 'no'}`];
  if (local?.candidateType === 'relay' && local.relayProtocol) {
    parts.push(`relay_proto=${local.relayProtocol}`);
  }
  if (typeof pair.currentRoundTripTime === 'number') {
    parts.push(`rtt_ms=${Math.round(pair.currentRoundTripTime * 1000)}`);
  }
  return parts.join(' ');
}

/** The byte totals and stats-clock time of one reading, kept to turn the NEXT one into a rate. */
export type MediaSnapshot = { atMs: number; bytesSent: number; bytesReceived: number };

/** The E2E worker's exact totals, answered to `getCounters` (never the sampled log lines). */
export type E2eCounters = {
  encFrames: number;
  decFrames: number;
  decFail: number;
  keyframesIn: number;
};

/** Everything a `[CALL_REPORT]` line says that `getStats()` cannot. */
export type CallReportContext = {
  callId: string;
  phase: 'tick' | 'end';
  /** Since the user's tap (call or answer), on `performance.now()`. */
  durMs: number;
  /** Tap to the first unmuted remote audio track; `null` while no audio has arrived. */
  setupMs: number | null;
  engine: string;
  ice: string;
  /** `null` when the worker could not be asked (it never started, or it was already gone). */
  e2e: E2eCounters | null;
};

/** What one reading measured, and the snapshot the next reading needs. */
export type CallReport = { line: string; snapshot: MediaSnapshot };

/** `turn:turn.cloudflare.com:3478?transport=udp` -> `turn.cloudflare.com:3478`. */
function turnHost(url: string | undefined): string | null {
  if (!url) return null;
  const match = /^turns?:([^?]+)/.exec(url);
  return match ? match[1] : null;
}

/** `audio/opus` -> `opus`; `-` when the codec is not reported. */
function codecName(entries: Map<string, StatsEntry>, rtp: StatsEntry | undefined): string {
  const mime = rtp?.codecId ? entries.get(rtp.codecId)?.mimeType : undefined;
  return mime ? (mime.split('/')[1] ?? mime).toLowerCase() : '-';
}

const fixed = (n: number | undefined, digits: number) =>
  typeof n === 'number' && Number.isFinite(n) ? n.toFixed(digits) : '-';

/**
 * Builds THE `[CALL_REPORT]` line of the revival plan (section 6, WP-C2): one per device, every
 * 10 s while in a call and once at its end, carrying the numbers a "the call connected but nobody
 * heard anything" report needs - `setup_ms`, `audio_level_in`, and `dec_frames` against
 * `dec_fail`, which separate a key mismatch from no media at all.
 *
 * Rates are computed between two readings on the stats' OWN timestamps, never on a wall clock, so
 * the same two reports always give the same line. Nothing in it names a person, an address, an
 * SDP or a credential: the in-app log that carries it is exported.
 *
 * @param stats The report from `RTCPeerConnection.getStats()`.
 * @param ctx What the service knows that the stats do not.
 * @param previous The snapshot of the previous reading, or `null` for the first one.
 */
export function buildCallReport(
  stats: RTCStatsReport,
  ctx: CallReportContext,
  previous: MediaSnapshot | null
): CallReport {
  const entries = new Map<string, StatsEntry>();
  stats.forEach((value: StatsEntry) => entries.set(value.id, value));
  const all = [...entries.values()];

  const outbound = all.filter((e) => e.type === 'outbound-rtp');
  const inbound = all.filter((e) => e.type === 'inbound-rtp');
  const inAudio = inbound.find((e) => e.kind === 'audio');
  const inVideo = inbound.find((e) => e.kind === 'video');
  const outAudioSource = all.find((e) => e.type === 'media-source' && e.kind === 'audio');

  const sum = (list: StatsEntry[], key: 'bytesSent' | 'bytesReceived') =>
    list.reduce((acc, e) => acc + (e[key] ?? 0), 0);
  const atMs = Math.max(0, ...all.map((e) => e.timestamp ?? 0));
  const snapshot: MediaSnapshot = {
    atMs,
    bytesSent: sum(outbound, 'bytesSent'),
    bytesReceived: sum(inbound, 'bytesReceived'),
  };
  const spanMs = previous ? atMs - previous.atMs : 0;
  const kbps = (now: number, before: number) =>
    previous && spanMs > 0 ? String(Math.round(((now - before) * 8) / spanMs)) : '-';

  const lost = inAudio?.packetsLost ?? 0;
  const received = inAudio?.packetsReceived ?? 0;
  const lossPct = received + lost > 0 ? ((lost * 100) / (received + lost)).toFixed(1) : '-';

  const localRelay = all.find((e) => e.type === 'local-candidate' && e.candidateType === 'relay');
  const e2e = ctx.e2e;

  const fields = [
    `[CALL_REPORT] call=${ctx.callId}`,
    `phase=${ctx.phase}`,
    `dur_ms=${Math.round(ctx.durMs)}`,
    `setup_ms=${ctx.setupMs === null ? '-' : Math.round(ctx.setupMs)}`,
    `engine=${ctx.engine}`,
    `ice=${ctx.ice}`,
    describeSelectedPair(stats),
    `turn=${turnHost(localRelay?.url) ?? '-'}`,
    `out_kbps=${kbps(snapshot.bytesSent, previous?.bytesSent ?? 0)}`,
    `in_kbps=${kbps(snapshot.bytesReceived, previous?.bytesReceived ?? 0)}`,
    `loss_in_pct=${lossPct}`,
    `jitter_ms=${typeof inAudio?.jitter === 'number' ? Math.round(inAudio.jitter * 1000) : '-'}`,
    `audio_level_out=${fixed(outAudioSource?.audioLevel, 3)}`,
    `audio_level_in=${fixed(inAudio?.audioLevel, 3)}`,
    `e2e=on`,
    `enc_frames=${e2e ? e2e.encFrames : '-'}`,
    `dec_frames=${e2e ? e2e.decFrames : '-'}`,
    `dec_fail=${e2e ? e2e.decFail : '-'}`,
    `keyframes_in=${e2e ? e2e.keyframesIn : '-'}`,
    `codec_a=${codecName(entries, inAudio)}`,
    `codec_v=${codecName(entries, inVideo)}`,
  ];
  return { line: fields.join(' '), snapshot };
}

/**
 * The report of a call this engine REFUSED before any request, because it cannot encrypt frames
 * (`RTCRtpScriptTransform` absent). One line, so a refusal is counted in the same grep as a call.
 *
 * @param callId The room id when answering a known call, `-` when starting one (none exists yet).
 */
export function refusedCallReport(callId: string, engine: string): string {
  return `[CALL_REPORT] call=${callId} phase=refused engine=${engine} e2e=refused reason=no-rtp-script-transform`;
}

/**
 * The engine a call ran on, as the report's `engine=` field: the browser family and major version
 * (`chromium-155`, `webkit-18`, `gecko-140`), prefixed by the app shell when there is one
 * (`tauri-android/chromium-140`). A family and a number, never the full user agent.
 */
export function describeEngine(userAgent: string, shell: 'android' | 'ios' | null): string {
  const major = (re: RegExp) => re.exec(userAgent)?.[1];
  const family = (() => {
    const gecko = major(/Firefox\/(\d+)/);
    if (gecko) return `gecko-${gecko}`;
    const chromium = major(/Chrom(?:e|ium)\/(\d+)/);
    if (chromium) return `chromium-${chromium}`;
    const webkit = major(/Version\/(\d+)[\d.]* .*Safari/) ?? major(/OS (\d+)_\d+.*AppleWebKit/);
    if (webkit) return `webkit-${webkit}`;
    return 'unknown';
  })();
  return shell ? `tauri-${shell}/${family}` : family;
}
