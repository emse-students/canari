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
