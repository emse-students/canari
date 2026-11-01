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

import { engineFromUserAgent, type E2eWorkerReport } from './callE2eReport';

/** The subset of an `RTCStatsReport` entry this reader looks at. */
type StatsEntry = {
  type: string;
  id: string;
  /** Milliseconds, on the browser's own stats clock - the only clock a rate is computed from. */
  timestamp?: number;
  /** Chromium: the ICE server URL a local relay candidate came from (no credential in it). */
  url?: string;
  kind?: string;
  bytesSent?: number;
  bytesReceived?: number;
  packetsLost?: number;
  packetsReceived?: number;
  /** Seconds. */
  jitter?: number;
  /** Cumulative energy of the audio (sum of squared levels times sample duration). */
  totalAudioEnergy?: number;
  /** Seconds of audio the energy above was counted over. */
  totalSamplesDuration?: number;
  codecId?: string;
  mimeType?: string;
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

/** The subset of an audio `outbound-rtp` / `inbound-rtp` / `codec` stats entry the codec line reads. */
type RtpCodecEntry = {
  type: string;
  id: string;
  kind?: string;
  mediaType?: string;
  codecId?: string;
  mimeType?: string;
  payloadType?: number;
  channels?: number;
  sdpFmtpLine?: string;
};

/**
 * Describes the audio codec each direction ACTUALLY uses, as the engine reports it on its
 * `outbound-rtp` / `inbound-rtp` entries: `audio send=audio/opus pt=111 ch=2 [fmtp] recv=...`.
 *
 * WHY (2026-10-19): an iPhone's call audio reached two different receivers as noise while every
 * Chromium pair was clean, and "which codec did WebKit really send" was a question no log
 * answered. The SDP says what was OFFERED; this is what the RTP streams were bound to.
 *
 * @param stats The report from `RTCPeerConnection.getStats()`.
 * @returns The line; a direction with no stream yet reads `none`, one with no codec entry `?`.
 */
export function describeAudioCodecs(stats: RTCStatsReport): string {
  const entries = new Map<string, RtpCodecEntry>();
  stats.forEach((value: RtpCodecEntry) => entries.set(value.id, value));
  const describe = (type: 'outbound-rtp' | 'inbound-rtp'): string => {
    const rtp = [...entries.values()].find(
      (e) => e.type === type && (e.kind ?? e.mediaType) === 'audio'
    );
    if (!rtp) return 'none';
    const codec = rtp.codecId ? entries.get(rtp.codecId) : undefined;
    if (!codec) return '?';
    const fmtp = codec.sdpFmtpLine ? ` [${codec.sdpFmtpLine}]` : '';
    return `${codec.mimeType ?? '?'} pt=${codec.payloadType ?? '?'} ch=${codec.channels ?? '?'}${fmtp}`;
  };
  return `audio send=${describe('outbound-rtp')} recv=${describe('inbound-rtp')}`;
}

/**
 * The audio codecs of an SDP in the order its first `m=audio` line lists them, as
 * `opus/111,red/63,...` - the preference the other side's answer picks from. `none` when the SDP
 * has no audio section. Carries codec names only, never an address.
 */
export function audioCodecOrder(sdp: string | undefined): string {
  if (!sdp) return 'none';
  const lines = sdp.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith('m=audio '));
  if (start < 0) return 'none';
  const pts = lines[start].split(' ').slice(3);
  const names = new Map<string, string>();
  for (let i = start + 1; i < lines.length && !lines[i].startsWith('m='); i++) {
    const m = /^a=rtpmap:(\d+) ([^/\s]+)/.exec(lines[i]);
    if (m) names.set(m[1], m[2].toLowerCase());
  }
  return pts.map((pt) => `${names.get(pt) ?? '?'}/${pt}`).join(',');
}

/**
 * Whether a finished ICE gathering that produced NO relay candidate is worth a WARN.
 *
 * WHY (CALL-GATHER-0, 2026-10-20, docs/wiki/device-readings-2026-10.md): libwebrtc's default
 * gather-once policy stops the allocator the moment a connection is writable, so a callee whose
 * direct pair answers before its STUN/TURN servers do finishes with `relay=0` and a WORKING call -
 * the old WARN fired on every LAN call and blamed TURN. A missing relay is only suspect when
 * gathering ends while ICE still has no working pair - and since the state read at that moment may
 * lag the pair that ended gathering, `CallService` only REMEMBERS a suspect gap and accuses it if
 * ICE then fails without ever connecting.
 */
export function relayGapIsSuspect(relayCount: number, ice: RTCIceConnectionState): boolean {
  return relayCount === 0 && ice !== 'connected' && ice !== 'completed';
}

/** The subset of a video `inbound-rtp` / `outbound-rtp` stats entry the video line reads. */
type VideoRtpEntry = RtpCodecEntry & {
  frameWidth?: number;
  frameHeight?: number;
  framesPerSecond?: number;
  framesDecoded?: number;
  keyFramesDecoded?: number;
  freezeCount?: number;
  totalFreezesDuration?: number;
  pliCount?: number;
  framesEncoded?: number;
  qualityLimitationReason?: string;
  encoderImplementation?: string;
  totalEncodeTime?: number;
};

/**
 * Describes the call's VIDEO as the engine reports it, both directions:
 * `video recv=video/VP8 640x480 fps=30 decoded=900 keyframes=1 freezes=0 (0 s) pli=0 | send=video/VP8 1280x720 fps=30 encoded=900 limit=none enc=libvpx encode_ms=4.1`.
 * A direction with no stream reads `none`. Logged at each conclusive E2E path check of a call that
 * carries video, so a phone reading says whether the picture decoded smoothly, not only whether it
 * was encrypted. Counts are cumulative over the stream's life; `encode_ms` is the mean encode time
 * per frame so far and `enc` the encoder (software `libvpx` or a hardware one) - what the phone
 * reading compares across the quality ladder's rungs (calls.md, "The quality ladder").
 */
export function describeVideoStats(stats: RTCStatsReport): string {
  const entries = new Map<string, VideoRtpEntry>();
  stats.forEach((value: VideoRtpEntry) => entries.set(value.id, value));
  const find = (type: 'outbound-rtp' | 'inbound-rtp') =>
    [...entries.values()].find((e) => e.type === type && (e.kind ?? e.mediaType) === 'video');
  const codecOf = (rtp: VideoRtpEntry) =>
    (rtp.codecId ? entries.get(rtp.codecId)?.mimeType : undefined) ?? '?';
  const size = (rtp: VideoRtpEntry) =>
    rtp.frameWidth ? `${rtp.frameWidth}x${rtp.frameHeight ?? '?'}` : '?x?';
  const fps = (rtp: VideoRtpEntry) =>
    typeof rtp.framesPerSecond === 'number' ? Math.round(rtp.framesPerSecond) : '?';
  const inbound = find('inbound-rtp');
  const outbound = find('outbound-rtp');
  const recv = inbound
    ? `${codecOf(inbound)} ${size(inbound)} fps=${fps(inbound)} decoded=${inbound.framesDecoded ?? '?'} keyframes=${inbound.keyFramesDecoded ?? '?'} freezes=${inbound.freezeCount ?? '?'} (${Math.round(inbound.totalFreezesDuration ?? 0)} s) pli=${inbound.pliCount ?? '?'}`
    : 'none';
  const encodeMs = (rtp: VideoRtpEntry) =>
    typeof rtp.totalEncodeTime === 'number' && rtp.framesEncoded
      ? Math.round((rtp.totalEncodeTime * 10_000) / rtp.framesEncoded) / 10
      : '?';
  const send = outbound
    ? `${codecOf(outbound)} ${size(outbound)} fps=${fps(outbound)} encoded=${outbound.framesEncoded ?? '?'} limit=${outbound.qualityLimitationReason ?? '?'} enc=${outbound.encoderImplementation ?? '?'} encode_ms=${encodeMs(outbound)}`
    : 'none';
  return `video recv=${recv} | send=${send}`;
}

/** The byte totals and stats-clock time of one reading, kept to turn the NEXT one into a rate. */
export interface MediaSnapshot {
  atMs: number;
  bytesSent: number;
  bytesReceived: number;
  /** `totalAudioEnergy` / `totalSamplesDuration` of the inbound audio; null when not reported. */
  audioIn: AudioEnergy | null;
  /** The same two counters of the microphone's `media-source`; null when not reported. */
  audioOut: AudioEnergy | null;
}

/** The two cumulative counters an audio LEVEL over an interval is computed from. */
export interface AudioEnergy {
  energy: number;
  seconds: number;
}

/** The counters of one stats entry, or null when the engine does not report both. */
function audioEnergyOf(e: StatsEntry | undefined): AudioEnergy | null {
  if (typeof e?.totalAudioEnergy !== 'number' || typeof e.totalSamplesDuration !== 'number') {
    return null;
  }
  return { energy: e.totalAudioEnergy, seconds: e.totalSamplesDuration };
}

/**
 * THE AUDIO LEVEL OVER THE INTERVAL, never one instant: `sqrt(dEnergy / dSeconds)`, the RMS level
 * the WebRTC stats spec defines from the two cumulative counters. The instantaneous `audioLevel` this
 * replaced is ONE sample per 10 s tick: in a conversation the listening side is silent most of the
 * time, and the owner's first production call read `audio_level_in=0.000` on 4 ticks of 5 while
 * 32-41 kbps of voice arrived. Since the call's start on the first reading (`previous` null); `-`
 * when the engine reports no counters, or no audio was counted in the interval.
 */
function intervalLevel(now: AudioEnergy | null, before: AudioEnergy | null): string {
  if (!now) return '-';
  const seconds = now.seconds - (before?.seconds ?? 0);
  const energy = now.energy - (before?.energy ?? 0);
  if (seconds <= 0 || energy < 0) return '-';
  return Math.sqrt(energy / seconds).toFixed(3);
}

/** Everything a `[CALL_REPORT]` line says that `getStats()` cannot. */
export interface CallReportContext {
  /** The room id: the same value as the relay's `room=`, the only join key between the halves. */
  callId: string;
  phase: 'tick' | 'end';
  /** Since the user's tap (call or answer), on `performance.now()`. */
  durMs: number;
  /**
   * The ring: its start (the caller's ring leaving, the callee's page ringing) to the answer; `null` before
   * an answer. A HUMAN's time, kept apart from the app's so neither hides the other.
   */
  ringMs: number | null;
  /** The answer to the first E2E proof of the call (`CallService.e2eProven`); `null` until then. */
  connectMs: number | null;
  /** `callReportEngine`. */
  engine: string;
  ice: string;
  /** The worker's answer to `report`; `null` when it could not be asked or did not answer. */
  e2e: E2eWorkerReport | null;
  /**
   * What the microphone sender carries (`CallMicSwitch.reportState`): `on` = RNNoise's output,
   * `off` = the user switched it off, `pending` = not proven running yet, `unavailable` = the
   * pipeline could not be built. `null` when no microphone is open.
   */
  ns: string | null;
  /** How many times this call's noise-suppression path failed (`CallMicSwitch.fallbackCount`). */
  nsFallbacks: number | null;
}

/** What one reading measured, and the snapshot the next reading needs. */
export interface CallReport {
  line: string;
  snapshot: MediaSnapshot;
}

/** `turn:turn.cloudflare.com:3478?transport=udp` -> `turn.cloudflare.com:3478` (no query, no credential). */
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

/**
 * Frames the receiver could not use: AES-GCM failures plus NON-empty frames too short to be one of
 * ours (a peer sending in clear). Empty frames are not counted - Chrome hands the receiver a few in
 * every call, and they carry nothing.
 */
function decryptFailuresOf(r: E2eWorkerReport): number {
  return r.decryptFailures + (r.tooShort - r.tooShortEmpty);
}

/**
 * Builds THE `[CALL_REPORT]` line of the revival plan (section 6, WP-C2): one per device, every
 * 10 s while in a call and once at its end, carrying the numbers a "the call connected but nobody
 * heard anything" report needs - `ring_ms` / `connect_ms`, `audio_level_in`, and `dec_frames` against
 * `dec_fail`, which separate a key mismatch from no media at all - and `relayed=`, the only field
 * that says whether a call cost TURN volume.
 *
 * Rates are computed between two readings on the stats' OWN timestamps, never on a wall clock, so
 * the same two reports always give the same line. Nothing in it names a person, an address, an
 * SDP or a credential: the in-app log that carries it is exported.
 *
 * @param stats The report from `RTCPeerConnection.getStats()`.
 * @param ctx What the service knows that the stats do not.
 * @param previous The snapshot of the previous reading of the SAME peer connection, or `null`.
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
    audioIn: audioEnergyOf(inAudio),
    audioOut: audioEnergyOf(outAudioSource),
  };
  const spanMs = previous ? atMs - previous.atMs : 0;
  // Never below 0: a byte total that went DOWN (a counter the engine reset) is no negative rate.
  const kbps = (now: number, before: number) =>
    previous && spanMs > 0 ? String(Math.max(0, Math.round(((now - before) * 8) / spanMs))) : '-';

  const lost = inAudio?.packetsLost ?? 0;
  const received = inAudio?.packetsReceived ?? 0;
  const lossPct = received + lost > 0 ? ((lost * 100) / (received + lost)).toFixed(1) : '-';

  const localRelay = all.find((e) => e.type === 'local-candidate' && e.candidateType === 'relay');
  const e2e = ctx.e2e;

  const fields = [
    `[CALL_REPORT] call=${ctx.callId}`,
    `phase=${ctx.phase}`,
    `dur_ms=${Math.round(ctx.durMs)}`,
    `ring_ms=${ctx.ringMs === null ? '-' : Math.round(ctx.ringMs)}`,
    `connect_ms=${ctx.connectMs === null ? '-' : Math.round(ctx.connectMs)}`,
    `engine=${ctx.engine}`,
    `ice=${ctx.ice}`,
    describeSelectedPair(stats),
    `turn=${turnHost(localRelay?.url) ?? '-'}`,
    `out_kbps=${kbps(snapshot.bytesSent, previous?.bytesSent ?? 0)}`,
    `in_kbps=${kbps(snapshot.bytesReceived, previous?.bytesReceived ?? 0)}`,
    `loss_in_pct=${lossPct}`,
    `jitter_ms=${typeof inAudio?.jitter === 'number' ? Math.round(inAudio.jitter * 1000) : '-'}`,
    `audio_level_out=${intervalLevel(snapshot.audioOut, previous?.audioOut ?? null)}`,
    `audio_level_in=${intervalLevel(snapshot.audioIn, previous?.audioIn ?? null)}`,
    // `on` only when the worker answered: without its counts this line cannot vouch for E2E.
    `e2e=${e2e ? 'on' : '-'}`,
    `enc_frames=${e2e ? e2e.encrypted.audio + e2e.encrypted.video : '-'}`,
    `dec_frames=${e2e ? e2e.decrypted.audio + e2e.decrypted.video : '-'}`,
    `dec_fail=${e2e ? decryptFailuresOf(e2e) : '-'}`,
    `keyframes_in=${e2e ? (e2e.videoKeyframesIn ?? '-') : '-'}`,
    `codec_a=${codecName(entries, inAudio)}`,
    `codec_v=${codecName(entries, inVideo)}`,
    `ns=${ctx.ns ?? '-'}`,
    `ns_fallbacks=${ctx.nsFallbacks ?? '-'}`,
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
 * The report's `engine=` field: the engine as the E2E worker report names it
 * (`engineFromUserAgent`: `Chrome/155`, `Safari/18`, `iOS/18` for a WKWebView, `Firefox/140`),
 * prefixed by the app shell when there is one (`tauri-android/Chrome/140`). A name and a major
 * version, never the whole user agent.
 */
export function callReportEngine(userAgent: string, shell: 'android' | 'ios' | null): string {
  const engine = engineFromUserAgent(userAgent);
  return shell ? `tauri-${shell}/${engine}` : engine;
}
