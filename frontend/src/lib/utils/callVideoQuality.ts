/**
 * How much picture a call's camera sends, and when that changes (2026-10-21).
 *
 * WHY. Lot 2 sent a fixed 640x480 at 30 fps capped at 700 kb/s: sharp on a phone screen, but below
 * what a good link carries, and nothing chose anything smaller when the link got worse - the
 * engine's own adaptation (GCC lowering its target, VP8's quality scaler) only ever acts inside
 * that one ceiling. The owner asked (2026-10-21) for 720p/30 at 1.5-2.5 Mb/s and an AUTOMATIC
 * degradation the way WhatsApp and FaceTime do it.
 *
 * WHAT. A LADDER of rungs (`CALL_VIDEO_LADDER`), each one encoding of the camera's sender: a
 * resolution (`scaleResolutionDownBy` of the 720p capture), a frame rate and a bitrate ceiling. A
 * call starts one rung below the top and moves on the sender's own `getStats()` evidence, read
 * every `CALL_VIDEO_QUALITY_SAMPLE_MS` (`CallVideoQualityLoop`, the one loop `CallService` and the
 * desktop rig both run):
 *
 * - DOWN after `DOWN_AFTER_BAD` consecutive bad samples, or at once on a severe one: loss in a FRESH
 *   receiver report, a round trip that says the path is queueing, the encoder over its CPU (it says
 *   `cpu` AND it spends `CPU_ENCODE_SHARE_BAD` of the wall clock encoding), or the encoder limited
 *   by `bandwidth` while the estimate is under what this rung needs. A drop on bandwidth goes
 *   straight to the highest rung the estimate can carry.
 * - UP after `required[rung]` consecutive clean samples: a fresh report with no loss, a known short
 *   round trip, an encoder that is not constrained, and an estimate that either carries the rung
 *   above or stands `HEADROOM_CLIMB` times above what is actually sent. That count starts at
 *   `UP_AFTER_GOOD` and DOUBLES each time a climb into that rung is followed by a drop within
 *   `PROBE_WATCH` samples (a failed probe), so a link that cannot hold a rung stops being asked.
 * - A RELAYED call (the selected ICE pair is a TURN relay) never sends above
 *   `CALL_VIDEO_RELAY_TOP_RUNG`: every relayed byte is billed and crosses the relay twice.
 *
 * Hysteresis is COUNTED, never timed: a camera that is off, or a sample read across a change, is no
 * evidence and moves nothing. The clock only paces the reading.
 *
 * WHY no reason the engine REPORTS is evidence on its own: `qualityLimitationReason` is libwebrtc's
 * adaptation STATE, and it outlives its cause - after a camera switch Chrome reported `bandwidth`
 * for a whole call against a 2.97 Mb/s estimate (rig, 2026-10-21). `qualityLimitationDurations`
 * cannot refresh it: it accrues for as long as the state holds. So `bandwidth` drops only against
 * a measured estimate, and `cpu` only against a measured encode load. Likewise the estimate alone
 * never drops a rung: a still scene encodes far below its ceiling, and libwebrtc's estimate does
 * not grow much above what is actually sent.
 *
 * Two controllers act on the picture: this ladder (the ceiling) and libwebrtc's own adaptation
 * inside it. `degradationPreference` is NOT set, so the engine's default stands (`balanced` on
 * Chromium for a camera); the loop logs what the sender reports at its start.
 */
import { applyCallVideoRung } from './callVideo';

/** One step of the ladder: what the camera's sender is allowed to send. */
export interface CallVideoRung {
  /** For the logs: the picture height for a 720p capture, and the frame rate. */
  name: string;
  /** Divides the capture's size (`RTCRtpEncodingParameters.scaleResolutionDownBy`). */
  scaleResolutionDownBy: number;
  /** Frames per second at most. */
  maxFramerate: number;
  /** The encoder's bitrate ceiling, bps. */
  maxBitrate: number;
  /** The estimate (bps) this rung needs to hold: under it, a bandwidth-limited encoder drops it. */
  needBitrate: number;
}

/**
 * Top first. 720p is the capture (`callVideoConstraints`); each `needBitrate` is at most the
 * `maxBitrate` of the rung BELOW, so a link that fills the ceiling of a rung qualifies for the next
 * one up (libwebrtc's estimate seldom grows past what it is allowed to send). The bottom rung needs
 * nothing: there is nowhere further down.
 */
export const CALL_VIDEO_LADDER: readonly CallVideoRung[] = [
  {
    name: '720p30',
    scaleResolutionDownBy: 1,
    maxFramerate: 30,
    maxBitrate: 2_500_000,
    needBitrate: 1_200_000,
  },
  {
    name: '480p30',
    scaleResolutionDownBy: 1.5,
    maxFramerate: 30,
    maxBitrate: 1_200_000,
    needBitrate: 600_000,
  },
  {
    name: '360p30',
    scaleResolutionDownBy: 2,
    maxFramerate: 30,
    maxBitrate: 700_000,
    needBitrate: 350_000,
  },
  {
    name: '360p15',
    scaleResolutionDownBy: 2,
    maxFramerate: 15,
    maxBitrate: 400_000,
    needBitrate: 180_000,
  },
  {
    name: '180p15',
    scaleResolutionDownBy: 4,
    maxFramerate: 15,
    maxBitrate: 200_000,
    needBitrate: 0,
  },
];

/**
 * The rung a camera starts on: 480p. libwebrtc's estimate starts near 300 kb/s and ramps over a
 * few seconds, so a call that opened at 720p would read "bandwidth" on its first samples and drop;
 * a clean link climbs to 720p after `UP_AFTER_GOOD` samples instead.
 */
export const CALL_VIDEO_START_RUNG = 1;
/**
 * The highest rung of a RELAYED call: 480p30, 1.2 Mb/s. Cloudflare TURN bills every byte and each
 * crosses the relay twice; 720p's 2.5 Mb/s would double a relayed call's cost for a phone screen.
 */
export const CALL_VIDEO_RELAY_TOP_RUNG = 1;
/** From this rung down the screen says this side's picture is reduced (`CallService.videoSendReduced`). */
export const CALL_VIDEO_REDUCED_FROM_RUNG = 3;
/** How often `getStats()` is read for the ladder. Paces the reading only: every decision is a count. */
export const CALL_VIDEO_QUALITY_SAMPLE_MS = 2_000;

/** Consecutive bad samples that drop a rung (a severe one drops at once). */
export const DOWN_AFTER_BAD = 2;
/** Consecutive clean samples that climb a rung, before any failed probe of it. */
export const UP_AFTER_GOOD = 3;
/** The most clean samples a climb can come to require, however often it failed. */
export const MAX_REQUIRED_GOOD = 48;
/**
 * Evidence samples after a climb during which a drop counts as that climb FAILING: 15 (30 s).
 * libwebrtc's estimate takes ten seconds and more to ramp into a new ceiling, so a link that
 * cannot hold the rung above often shows it only after that; at 5 samples such a link cycled up
 * and down every ~20 s for the whole call (review of #2173).
 */
export const PROBE_WATCH = 15;
/** Fewer packets than this between two samples cannot give a loss fraction worth reading. */
export const MIN_PACKETS_FOR_LOSS = 20;
/** Evidence samples with no fresh loss figure before the ladder says, ONCE, that it cannot climb. */
export const NO_LOSS_REPORT_WARN_AFTER = 5;

/**
 * An estimate at least this many times the bitrate actually sent is HEADROOM: libwebrtc's estimate
 * settles near what a full link carries (ratio ~1) and grows to ~1.5x what is sent on a link with
 * room. A cheap scene that never fills its ceiling climbs on this, not on the rung's need
 * (measured in the rig, 2026-10-21: 670 kb/s sent at 480p never let the estimate reach 1.2 Mb/s).
 */
export const HEADROOM_CLIMB = 1.3;
/**
 * Share of the wall clock the encoder spends encoding (delta `totalEncodeTime` / delta t) that,
 * with the encoder saying `cpu`, is an overloaded CPU: 0.5 = half of every frame interval. Under
 * `CPU_ENCODE_SHARE_CLEAR` a lingering `cpu` state no longer stops a climb.
 */
export const CPU_ENCODE_SHARE_BAD = 0.5;
export const CPU_ENCODE_SHARE_CLEAR = 0.3;
/** Loss at or above this fraction is a bad sample; under `LOSS_CLEAN` a clean one. */
export const LOSS_BAD = 0.1;
export const LOSS_SEVERE = 0.25;
export const LOSS_CLEAN = 0.03;
/** Round trip (s): at or above `RTT_BAD` the path is queueing; under `RTT_CLEAN` it may climb. */
export const RTT_BAD = 0.8;
export const RTT_SEVERE = 1.5;
export const RTT_CLEAN = 0.35;

/** What one `getStats()` says about the camera's sender, cumulative counters as the engine keeps them. */
export interface VideoSendSample {
  framesEncoded: number | null;
  packetsSent: number | null;
  /** The peer's report of packets lost (`remote-inbound-rtp`), cumulative AS OF ITS LAST REPORT. */
  packetsLost: number | null;
  /** The receiver reports counted on `remote-inbound-rtp` (`reportsReceived`): what makes it fresh. */
  remoteReports: number | null;
  /** `remote-inbound-rtp.timestamp` (ms), when the engine does not count reports. */
  remoteTimestamp: number | null;
  /** Seconds: the round trip of the peer's last report (`remote-inbound-rtp.roundTripTime`). */
  remoteRtt: number | null;
  /** Seconds: the selected ICE pair's STUN round trip, read only when there is no receiver report. */
  pairRtt: number | null;
  /** The congestion controller's estimate (`candidate-pair.availableOutgoingBitrate`), bps. */
  availableOutgoingBitrate: number | null;
  /** `none`, `cpu`, `bandwidth` or `other`, as the encoder reports it (a STATE, not an event). */
  qualityLimitationReason: string | null;
  bytesSent: number | null;
  /** Seconds spent encoding, cumulative - the encode load, and the CPU cost per rung. */
  totalEncodeTime: number | null;
  frameWidth: number | null;
  frameHeight: number | null;
  framesPerSecond: number | null;
  /** The outbound entry's own `timestamp` (ms): the interval the deltas are counted over. */
  timestamp: number | null;
  /** The selected ICE pair goes through a TURN relay; `null` when no pair is selected yet. */
  relayed: boolean | null;
}

type StatsEntry = Record<string, unknown> & { type?: string };

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Reads the camera sender's sample out of a peer connection's stats, or `null` when there is no
 * outbound video stream. Chromium and WebKit name the kind `kind`; older reports `mediaType`.
 */
export function readVideoSendSample(stats: RTCStatsReport): VideoSendSample | null {
  // Keyed by the report's own key, which IS each entry's id.
  const entries = new Map<string, StatsEntry>();
  stats.forEach((value: StatsEntry, key: string) => entries.set(key, value));
  const isVideo = (e: StatsEntry) => (e.kind ?? e.mediaType) === 'video';
  const all = [...entries.entries()];
  const outEntry = all.find(([, e]) => e.type === 'outbound-rtp' && isVideo(e));
  if (!outEntry) return null;
  const [outId, out] = outEntry;
  const remote = all.find(
    ([, e]) => e.type === 'remote-inbound-rtp' && (e.localId === outId || isVideo(e))
  )?.[1];
  let pair: StatsEntry | undefined;
  const transport = all.find(([, e]) => e.type === 'transport' && e.selectedCandidatePairId)?.[1];
  if (transport) pair = entries.get(String(transport.selectedCandidatePairId));
  pair ??= all.find(([, e]) => e.type === 'candidate-pair' && e.selected === true)?.[1];
  const typeOf = (id: unknown) =>
    typeof id === 'string' ? (entries.get(id)?.candidateType as string | undefined) : undefined;
  const relayed = pair
    ? typeOf(pair.localCandidateId) === 'relay' || typeOf(pair.remoteCandidateId) === 'relay'
    : null;
  return {
    framesEncoded: num(out.framesEncoded),
    packetsSent: num(out.packetsSent),
    packetsLost: num(remote?.packetsLost),
    remoteReports: num(remote?.reportsReceived),
    remoteTimestamp: num(remote?.timestamp),
    remoteRtt: num(remote?.roundTripTime),
    pairRtt: num(pair?.currentRoundTripTime),
    availableOutgoingBitrate: num(pair?.availableOutgoingBitrate),
    qualityLimitationReason:
      typeof out.qualityLimitationReason === 'string' ? out.qualityLimitationReason : null,
    bytesSent: num(out.bytesSent),
    totalEncodeTime: num(out.totalEncodeTime),
    frameWidth: num(out.frameWidth),
    frameHeight: num(out.frameHeight),
    framesPerSecond: num(out.framesPerSecond),
    timestamp: num(out.timestamp),
    relayed,
  };
}

/** What two samples say about the link, each field `null` when they cannot say it. */
export interface VideoEvidence {
  /** Fraction of the packets sent between the samples that a FRESH peer report counts lost. */
  loss: number | null;
  /** Seconds: a fresh report's round trip (or the pair's when the peer sends no report at all). */
  rtt: number | null;
  available: number | null;
  limit: string | null;
  /** Video bits per second actually sent between the samples, over the stats' own timestamps. */
  sentBitrate: number | null;
  /** Share of the interval the encoder spent encoding (delta `totalEncodeTime` / delta t). */
  encodeShare: number | null;
  /** The selected pair is a TURN relay; `null` when unknown. */
  relayed: boolean | null;
}

/**
 * Whether the peer's receiver report moved between two samples: its report count grew, or - where
 * the engine counts none - its timestamp did. A report that did not move describes packets sent
 * BEFORE the interval: dividing its losses by this interval's packets read 0 % during an outage.
 */
function remoteReportAdvanced(prev: VideoSendSample, cur: VideoSendSample): boolean {
  if (prev.remoteReports !== null && cur.remoteReports !== null) {
    return cur.remoteReports > prev.remoteReports;
  }
  if (prev.remoteTimestamp !== null && cur.remoteTimestamp !== null) {
    return cur.remoteTimestamp > prev.remoteTimestamp;
  }
  return false;
}

/**
 * The evidence between two samples of the same sender, or `null` when there is none: no earlier
 * sample, or no frame encoded between them (the camera is off, or not producing) - nothing sent
 * says nothing about the link. A receiver report that did not advance gives NO loss and NO round
 * trip (both `null`, which never reads as clean).
 */
export function videoEvidence(
  prev: VideoSendSample | null,
  cur: VideoSendSample | null
): VideoEvidence | null {
  if (!prev || !cur) return null;
  if (prev.framesEncoded === null || cur.framesEncoded === null) return null;
  if (cur.framesEncoded <= prev.framesEncoded) return null;
  const fresh = remoteReportAdvanced(prev, cur);
  const noReportAtAll = cur.remoteReports === null && cur.remoteTimestamp === null;
  let loss: number | null = null;
  if (
    fresh &&
    prev.packetsSent !== null &&
    cur.packetsSent !== null &&
    prev.packetsLost !== null &&
    cur.packetsLost !== null
  ) {
    const sent = cur.packetsSent - prev.packetsSent;
    if (sent >= MIN_PACKETS_FOR_LOSS) {
      loss = Math.min(1, Math.max(0, (cur.packetsLost - prev.packetsLost) / sent));
    }
  }
  const rtt = fresh ? cur.remoteRtt : noReportAtAll ? cur.pairRtt : null;
  const dt =
    prev.timestamp !== null && cur.timestamp !== null && cur.timestamp > prev.timestamp
      ? (cur.timestamp - prev.timestamp) / 1000
      : null;
  const sentBitrate =
    dt !== null && prev.bytesSent !== null && cur.bytesSent !== null
      ? (Math.max(0, cur.bytesSent - prev.bytesSent) * 8) / dt
      : null;
  const encodeShare =
    dt !== null && prev.totalEncodeTime !== null && cur.totalEncodeTime !== null
      ? Math.max(0, cur.totalEncodeTime - prev.totalEncodeTime) / dt
      : null;
  return {
    loss,
    rtt,
    available: cur.availableOutgoingBitrate,
    limit: cur.qualityLimitationReason,
    sentBitrate,
    encodeShare,
    relayed: cur.relayed,
  };
}

/** The verdict of one evidence sample at one rung. */
export interface VideoVerdict {
  verdict: 'bad' | 'good' | 'steady';
  /** A bad sample that drops at once, without waiting for a second one. */
  severe: boolean;
  /** The rung a drop should land on (always below `rung` when bad). */
  target: number;
}

/** The lowest index (highest rung) at or below `from` whose need the estimate carries. */
function rungCarriedBy(available: number, from: number): number {
  for (let i = from; i < CALL_VIDEO_LADDER.length; i++) {
    if (CALL_VIDEO_LADDER[i].needBitrate <= available) return i;
  }
  return CALL_VIDEO_LADDER.length - 1;
}

/** Judges one evidence sample at `rung` (see the module comment for the rules). */
export function judgeVideoEvidence(rung: number, ev: VideoEvidence): VideoVerdict {
  const last = CALL_VIDEO_LADDER.length - 1;
  const need = CALL_VIDEO_LADDER[rung].needBitrate;
  // An unknown estimate is no evidence either way: never a drop on its own absence.
  const starved = ev.available !== null && ev.available < need;
  const bandwidthBad = ev.limit === 'bandwidth' && starved;
  // `cpu` is a state; the encode load measured over THIS interval is what makes it evidence.
  const cpuBad =
    ev.limit === 'cpu' && ev.encodeShare !== null && ev.encodeShare >= CPU_ENCODE_SHARE_BAD;
  const bad =
    (ev.loss !== null && ev.loss >= LOSS_BAD) ||
    (ev.rtt !== null && ev.rtt >= RTT_BAD) ||
    cpuBad ||
    bandwidthBad;
  if (bad) {
    const severe =
      (ev.loss !== null && ev.loss >= LOSS_SEVERE) ||
      (ev.rtt !== null && ev.rtt >= RTT_SEVERE) ||
      (bandwidthBad && ev.available !== null && ev.available < need / 2);
    const next = Math.min(rung + 1, last);
    const target =
      bandwidthBad && ev.available !== null
        ? Math.max(next, rungCarriedBy(ev.available, next))
        : next;
    return { verdict: 'bad', severe, target };
  }
  if (rung === 0) return { verdict: 'steady', severe: false, target: rung };
  const upNeed = CALL_VIDEO_LADDER[rung - 1].needBitrate;
  const carriesUp = ev.available !== null && ev.available >= upNeed;
  const headroom =
    ev.available !== null &&
    ev.sentBitrate !== null &&
    ev.sentBitrate > 0 &&
    ev.available >= HEADROOM_CLIMB * ev.sentBitrate;
  const roomUp = carriesUp || headroom;
  const cpuClear = ev.encodeShare !== null && ev.encodeShare < CPU_ENCODE_SHARE_CLEAR;
  // A lingering `bandwidth` or `cpu` state blocks a climb only while the measurements do not
  // contradict it: the estimate showing BOTH the rung above and room, the encoder mostly idle.
  const unconstrained =
    ev.limit === 'none' ||
    (ev.limit === null && roomUp) ||
    (ev.limit === 'bandwidth' && carriesUp && headroom) ||
    (ev.limit === 'cpu' && cpuClear && roomUp);
  const good =
    ev.loss !== null &&
    ev.loss < LOSS_CLEAN &&
    ev.rtt !== null &&
    ev.rtt < RTT_CLEAN &&
    unconstrained &&
    (ev.available === null || roomUp);
  return { verdict: good ? 'good' : 'steady', severe: false, target: rung };
}

/** The ladder's memory between samples. */
export interface VideoQualityState {
  rung: number;
  badStreak: number;
  goodStreak: number;
  /** Clean samples needed to climb INTO rung `i` (index `i`); doubled by each failed probe of it. */
  required: number[];
  /** The last climb, while a drop out of it would still count as that climb failing. */
  probe: { to: number; samples: number } | null;
  /** The next evidence straddles a change of encoding: read, never judged. */
  settling: boolean;
  /** Consecutive evidence samples with no fresh loss figure. */
  noLossStreak: number;
  /** The "no loss figure" WARN was given: once per ladder. */
  noLossWarned: boolean;
}

/** A fresh ladder on `CALL_VIDEO_START_RUNG`. */
export function initialVideoQuality(rung = CALL_VIDEO_START_RUNG): VideoQualityState {
  return {
    rung,
    badStreak: 0,
    goodStreak: 0,
    required: CALL_VIDEO_LADDER.map(() => UP_AFTER_GOOD),
    probe: null,
    settling: false,
    noLossStreak: 0,
    noLossWarned: false,
  };
}

/** A rung change the ladder decided, with what decided it (for the one log line). */
export interface VideoQualityChange {
  from: number;
  to: number;
  direction: 'down' | 'up';
  /** `relay`: the call went through a TURN relay above `CALL_VIDEO_RELAY_TOP_RUNG`. */
  cause: 'evidence' | 'relay';
  /** How many samples decided it (the streak). */
  samples: number;
  severe: boolean;
  /** A drop out of a rung climbed into `PROBE_WATCH` samples ago or less. */
  probeFailed: boolean;
  /** After a failed probe: the clean samples the next climb into `from` will need. */
  nextRequired: number | null;
  evidence: VideoEvidence;
}

export interface VideoQualityStep {
  state: VideoQualityState;
  change: VideoQualityChange | null;
  /** Set ONCE per ladder, when the loss figure has been missing `NO_LOSS_REPORT_WARN_AFTER` times. */
  noLossReport: boolean;
}

/** The highest rung (lowest index) this evidence allows: a relayed call is capped. */
function ceilingOf(ev: VideoEvidence): number {
  return ev.relayed === true ? CALL_VIDEO_RELAY_TOP_RUNG : 0;
}

/**
 * One sample's step. `null` evidence (camera off, nothing encoded, first sample) moves nothing and
 * breaks both streaks: hysteresis counts CONSECUTIVE evidence.
 */
export function stepVideoQuality(
  state: VideoQualityState,
  ev: VideoEvidence | null
): VideoQualityStep {
  if (!ev) {
    return { state: { ...state, badStreak: 0, goodStreak: 0 }, change: null, noLossReport: false };
  }
  const ceiling = ceilingOf(ev);
  if (state.rung < ceiling) {
    // Not a judgement: a relayed call is never above its cap, settling or not.
    return {
      state: {
        ...state,
        rung: ceiling,
        badStreak: 0,
        goodStreak: 0,
        probe: null,
        settling: true,
      },
      change: {
        from: state.rung,
        to: ceiling,
        direction: 'down',
        cause: 'relay',
        samples: 1,
        severe: false,
        probeFailed: false,
        nextRequired: null,
        evidence: ev,
      },
      noLossReport: false,
    };
  }
  if (state.settling) {
    return { state: { ...state, settling: false }, change: null, noLossReport: false };
  }
  const noLossStreak = ev.loss === null ? state.noLossStreak + 1 : 0;
  const noLossReport = !state.noLossWarned && noLossStreak >= NO_LOSS_REPORT_WARN_AFTER;
  const probe =
    state.probe && state.probe.samples < PROBE_WATCH
      ? { ...state.probe, samples: state.probe.samples + 1 }
      : null;
  const v = judgeVideoEvidence(state.rung, ev);
  const base = {
    ...state,
    probe,
    noLossStreak,
    noLossWarned: state.noLossWarned || noLossReport,
  };

  if (v.verdict === 'bad') {
    const badStreak = state.badStreak + 1;
    const last = CALL_VIDEO_LADDER.length - 1;
    if (state.rung < last && (v.severe || badStreak >= DOWN_AFTER_BAD)) {
      const probeFailed = !!probe && probe.to === state.rung;
      const required = [...state.required];
      if (probeFailed) required[state.rung] = Math.min(required[state.rung] * 2, MAX_REQUIRED_GOOD);
      return {
        state: {
          ...base,
          rung: v.target,
          badStreak: 0,
          goodStreak: 0,
          required,
          probe: null,
          settling: true,
        },
        change: {
          from: state.rung,
          to: v.target,
          direction: 'down',
          cause: 'evidence',
          samples: badStreak,
          severe: v.severe,
          probeFailed,
          nextRequired: probeFailed ? required[state.rung] : null,
          evidence: ev,
        },
        noLossReport,
      };
    }
    return { state: { ...base, badStreak, goodStreak: 0 }, change: null, noLossReport };
  }

  if (v.verdict === 'good' && state.rung - 1 >= ceiling) {
    const goodStreak = state.goodStreak + 1;
    const to = state.rung - 1;
    if (goodStreak >= state.required[to]) {
      return {
        state: {
          ...base,
          rung: to,
          badStreak: 0,
          goodStreak: 0,
          probe: { to, samples: 0 },
          settling: true,
        },
        change: {
          from: state.rung,
          to,
          direction: 'up',
          cause: 'evidence',
          samples: goodStreak,
          severe: false,
          probeFailed: false,
          nextRequired: null,
          evidence: ev,
        },
        noLossReport,
      };
    }
    return { state: { ...base, goodStreak, badStreak: 0 }, change: null, noLossReport };
  }

  return { state: { ...base, badStreak: 0, goodStreak: 0 }, change: null, noLossReport };
}

/** `loss=4% rtt=120ms limit=bandwidth avail=850kbps sent=610kbps enc=12%`, `?` for the unknown. */
export function describeVideoEvidence(ev: VideoEvidence): string {
  const kbps = (v: number | null) => (v === null ? '?' : `${Math.round(v / 1000)}kbps`);
  const pct = (v: number | null) => (v === null ? '?' : `${Math.round(v * 100)}%`);
  const rtt = ev.rtt === null ? '?' : `${Math.round(ev.rtt * 1000)}ms`;
  const relay = ev.relayed === true ? ' relayed' : '';
  return `loss=${pct(ev.loss)} rtt=${rtt} limit=${ev.limit ?? '?'} avail=${kbps(ev.available)} sent=${kbps(ev.sentBitrate)} enc=${pct(ev.encodeShare)}${relay}`;
}

/** The one log line of a rung change. */
export function describeVideoQualityChange(c: VideoQualityChange): string {
  const from = CALL_VIDEO_LADDER[c.from].name;
  const to = CALL_VIDEO_LADDER[c.to].name;
  const how =
    c.cause === 'relay'
      ? 'the call went through a TURN relay (capped)'
      : c.direction === 'down'
        ? `${c.severe ? 'a severe sample' : `${c.samples} bad samples`}${c.probeFailed ? `, the climb into ${from} failed - the next one needs ${c.nextRequired} clean samples` : ''}`
        : `${c.samples} clean samples`;
  return `video quality ${c.direction} ${from} -> ${to} after ${how} (${describeVideoEvidence(c.evidence)})`;
}

/** What the loop needs from its host: the peer connection, the sender, the log, and a timer. */
export interface CallVideoQualityLoopHost {
  pc: { getStats(): Promise<RTCStatsReport> };
  sender: RTCRtpSender;
  log: (msg: string) => void;
  /** Told after each rung the sender ACCEPTED whether that rung is a reduced picture. */
  onReduced: (reduced: boolean) => void;
  setTimer: (fn: () => void, ms: number) => number;
  clearTimer: (id: number) => void;
}

/**
 * The ladder's loop - sample, step, apply - the ONE implementation `CallService` and the desktop
 * rig (`tools/call-audio-fidelity`) run, so the rig measures the app's loop and not a copy.
 *
 * - `start()` applies `CALL_VIDEO_START_RUNG`, logs the sender's `degradationPreference`, and reads
 *   a sample every `CALL_VIDEO_QUALITY_SAMPLE_MS`.
 * - A sender with no track (the camera OFF) is no evidence: the loop breaks its streaks, forgets
 *   its baseline and STOPS its timer; `resume()` (the camera back on the same sender) re-arms it.
 * - A rung the engine refuses is logged at ERROR and STOPS the loop; the sender keeps the last
 *   rung it accepted, so `onReduced` is not touched (the picture stays what it was).
 */
export class CallVideoQualityLoop {
  private state = initialVideoQuality();
  private prev: VideoSendSample | null = null;
  private timer: number | null = null;
  private stopped = false;
  private sampling = false;
  private statsFailed = false;
  /** The rung the sender ACCEPTED last; `null` until the start rung is accepted. */
  private applied: number | null = null;
  /** Every change the loop APPLIED, in order (the rig's result). */
  readonly changes: VideoQualityChange[] = [];

  constructor(private readonly host: CallVideoQualityLoopHost) {}

  /** The rung the sender is on (the last one it accepted), `null` before the first. */
  get rung(): number | null {
    return this.applied;
  }

  get running(): boolean {
    return !this.stopped;
  }

  start(): void {
    const { sender, log } = this.host;
    const rung = CALL_VIDEO_LADDER[this.state.rung];
    let preference = 'unset';
    try {
      const p = (sender.getParameters() as { degradationPreference?: string })
        .degradationPreference;
      if (p) preference = p;
    } catch (e) {
      preference = `unreadable (${String(e)})`;
    }
    log(`[Call] video quality ladder starts on ${rung.name} (degradationPreference=${preference})`);
    void applyCallVideoRung(sender, rung, log).then((ok) => {
      if (this.stopped) return;
      if (!ok) {
        log(`[Call] ERROR video quality ladder not started: the sender refused ${rung.name}`);
        this.stop();
        return;
      }
      // A change applied meanwhile already said what the sender carries.
      if (this.applied === null) {
        this.applied = CALL_VIDEO_START_RUNG;
        this.host.onReduced(CALL_VIDEO_START_RUNG >= CALL_VIDEO_REDUCED_FROM_RUNG);
      }
    });
    this.arm();
  }

  /** The camera is sending again on the same sender: sampling restarts from a new baseline. */
  resume(): void {
    if (this.stopped || this.timer !== null || this.sampling) return;
    this.prev = null;
    this.arm();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) this.host.clearTimer(this.timer);
    this.timer = null;
  }

  private arm(): void {
    if (this.stopped || !this.host.sender.track) return;
    this.timer = this.host.setTimer(() => {
      this.timer = null;
      void this.sample();
    }, CALL_VIDEO_QUALITY_SAMPLE_MS);
  }

  private async sample(): Promise<void> {
    if (this.stopped) return;
    const { sender, log } = this.host;
    if (!sender.track) {
      // The camera is off: no evidence, no baseline, no timer until `resume()`.
      this.state = stepVideoQuality(this.state, null).state;
      this.prev = null;
      return;
    }
    this.sampling = true;
    let sample: VideoSendSample | null = null;
    try {
      sample = readVideoSendSample(await this.host.pc.getStats());
    } catch (e) {
      if (!this.statsFailed) {
        this.statsFailed = true;
        log(`[Call] WARN video quality: getStats failed (${String(e)}) - no evidence`);
      }
    }
    try {
      if (this.stopped) return;
      const step = stepVideoQuality(this.state, videoEvidence(this.prev, sample));
      this.prev = sample;
      this.state = step.state;
      if (step.noLossReport) {
        log(
          `[Call] WARN video quality: no fresh loss figure from the peer in ${NO_LOSS_REPORT_WARN_AFTER} samples - the ladder holds ${CALL_VIDEO_LADDER[this.state.rung].name} and cannot climb`
        );
      }
      if (step.change) {
        log(`[Call] ${describeVideoQualityChange(step.change)}`);
        const ok = await applyCallVideoRung(sender, CALL_VIDEO_LADDER[step.change.to], log);
        if (this.stopped) return;
        if (!ok) {
          log('[Call] ERROR video quality ladder stopped: the sender refused a rung');
          this.stop();
          return;
        }
        this.changes.push(step.change);
        this.applied = step.change.to;
        this.host.onReduced(step.change.to >= CALL_VIDEO_REDUCED_FROM_RUNG);
      }
    } finally {
      this.sampling = false;
    }
    this.arm();
  }
}
