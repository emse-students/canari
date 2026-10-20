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
 * gathering ends while ICE still has no working pair: that call has nothing to fall back on.
 */
export function relayGapIsSuspect(relayCount: number, ice: RTCIceConnectionState): boolean {
  return relayCount === 0 && ice !== 'connected' && ice !== 'completed';
}
