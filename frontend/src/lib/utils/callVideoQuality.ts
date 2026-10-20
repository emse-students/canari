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
 * resolution (`scaleResolutionDownBy` of the 1280x720 capture), a frame rate and a bitrate ceiling.
 * A call starts one rung below the top and moves on the sender's own `getStats()` evidence, read
 * every `CALL_VIDEO_QUALITY_SAMPLE_MS`:
 *
 * - DOWN after `DOWN_AFTER_BAD` consecutive bad samples, or at once on a severe one: loss, a round
 *   trip that says the path is queueing, the encoder saying its CPU cannot keep up, or the encoder
 *   saying it had to shrink the picture for want of bandwidth while the estimate is under what this
 *   rung needs. A drop on bandwidth goes straight to the highest rung the estimate can carry.
 * - UP after `required[rung]` consecutive clean samples: no loss, a short round trip, an encoder
 *   that is not constrained, and an estimate that either carries the rung above or stands
 *   `HEADROOM_CLIMB` times above what is actually sent (a cheap scene never fills its ceiling, and
 *   the estimate follows what is sent). That count starts at
 *   `UP_AFTER_GOOD` and DOUBLES each time a climb into that rung is followed by a drop within
 *   `PROBE_WATCH` samples (a failed probe), so a link that cannot hold a rung stops being asked.
 *
 * Hysteresis is COUNTED, never timed: a camera that is off, or a sample read across a change, is no
 * evidence and moves nothing. The clock only paces the reading.
 *
 * WHY the estimate alone never drops a rung: a still scene encodes far below its ceiling, and
 * libwebrtc's estimate does not grow much above what is actually sent - "low available bitrate" is
 * then the scene, not the network. Only the ENCODER's own `qualityLimitationReason` says it wanted
 * more than it was given.
 *
 * Pure: `CallService` and the desktop rig (`tools/call-audio-fidelity`) both run it on real stats.
 */

/** One step of the ladder: what the camera's sender is allowed to send. */
export interface CallVideoRung {
  /** For the logs: the picture height for a 1280x720 capture, and the frame rate. */
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
/** Evidence samples after a climb during which a drop counts as that climb FAILING. */
export const PROBE_WATCH = 5;
/** Fewer packets than this between two samples cannot give a loss fraction worth reading. */
export const MIN_PACKETS_FOR_LOSS = 20;
/** Evidence samples with no loss report before the ladder says, once, that it cannot climb. */
export const NO_LOSS_REPORT_WARN_AFTER = 5;

/**
 * An estimate at least this many times the bitrate actually sent is HEADROOM: libwebrtc's estimate
 * settles near what a full link carries (ratio ~1) and grows to ~1.5x what is sent on a link with
 * room. A cheap scene that never fills its ceiling climbs on this, not on the rung's need
 * (measured in the rig, 2026-10-21: 670 kb/s sent at 480p never let the estimate reach 1.2 Mb/s).
 */
export const HEADROOM_CLIMB = 1.3;
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
  /** The peer's report of packets lost (`remote-inbound-rtp`), cumulative. */
  packetsLost: number | null;
  /** Seconds: the peer's report (`remote-inbound-rtp`), else the selected ICE pair's. */
  rtt: number | null;
  /** The congestion controller's estimate (`candidate-pair.availableOutgoingBitrate`), bps. */
  availableOutgoingBitrate: number | null;
  /** `none`, `cpu`, `bandwidth` or `other`, as the encoder reports it. */
  qualityLimitationReason: string | null;
  bytesSent: number | null;
  /** Seconds spent encoding, cumulative - the CPU cost the phone reading compares across rungs. */
  totalEncodeTime: number | null;
  frameWidth: number | null;
  frameHeight: number | null;
  framesPerSecond: number | null;
  /** The outbound entry's own `timestamp` (ms): the interval the bytes sent are counted over. */
  timestamp: number | null;
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
  return {
    framesEncoded: num(out.framesEncoded),
    packetsSent: num(out.packetsSent),
    packetsLost: num(remote?.packetsLost),
    rtt: num(remote?.roundTripTime) ?? num(pair?.currentRoundTripTime),
    availableOutgoingBitrate: num(pair?.availableOutgoingBitrate),
    qualityLimitationReason:
      typeof out.qualityLimitationReason === 'string' ? out.qualityLimitationReason : null,
    bytesSent: num(out.bytesSent),
    totalEncodeTime: num(out.totalEncodeTime),
    frameWidth: num(out.frameWidth),
    frameHeight: num(out.frameHeight),
    framesPerSecond: num(out.framesPerSecond),
    timestamp: num(out.timestamp),
  };
}

/** What two samples say about the link, each field `null` when they cannot say it. */
export interface VideoEvidence {
  /** Fraction of the packets sent between the samples that the peer reported lost. */
  loss: number | null;
  rtt: number | null;
  available: number | null;
  limit: string | null;
  /** Video bits per second actually sent between the samples, over the stats' own timestamps. */
  sentBitrate: number | null;
}

/**
 * The evidence between two samples of the same sender, or `null` when there is none: no earlier
 * sample, or no frame encoded between them (the camera is off, or not producing) - nothing sent
 * says nothing about the link.
 */
export function videoEvidence(
  prev: VideoSendSample | null,
  cur: VideoSendSample | null
): VideoEvidence | null {
  if (!prev || !cur) return null;
  if (prev.framesEncoded === null || cur.framesEncoded === null) return null;
  if (cur.framesEncoded <= prev.framesEncoded) return null;
  let loss: number | null = null;
  if (
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
  let sentBitrate: number | null = null;
  if (
    prev.bytesSent !== null &&
    cur.bytesSent !== null &&
    prev.timestamp !== null &&
    cur.timestamp !== null &&
    cur.timestamp > prev.timestamp
  ) {
    const bits = Math.max(0, cur.bytesSent - prev.bytesSent) * 8;
    sentBitrate = (bits * 1000) / (cur.timestamp - prev.timestamp);
  }
  return {
    loss,
    rtt: cur.rtt,
    available: cur.availableOutgoingBitrate,
    limit: cur.qualityLimitationReason,
    sentBitrate,
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
  const starved = ev.available !== null && ev.available < need;
  const bandwidthBad = ev.limit === 'bandwidth' && (ev.available === null || starved);
  const bad =
    (ev.loss !== null && ev.loss >= LOSS_BAD) ||
    (ev.rtt !== null && ev.rtt >= RTT_BAD) ||
    ev.limit === 'cpu' ||
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
  // `bandwidth` can outlive its cause: after a camera switch Chrome kept reporting it at 700 kb/s
  // sent against a 2.97 Mb/s estimate for the whole call (rig, 2026-10-21) - libwebrtc's own
  // start-up adaptation, not the link. It blocks a climb only while the estimate does not show
  // BOTH the rung above and room over what is sent.
  const unconstrained =
    ev.limit === 'none' ||
    (ev.limit === null && roomUp) ||
    (ev.limit === 'bandwidth' && carriesUp && headroom);
  const good =
    ev.loss !== null &&
    ev.loss < LOSS_CLEAN &&
    (ev.rtt === null || ev.rtt < RTT_CLEAN) &&
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
  /** Consecutive evidence samples with no loss figure (a peer that sends no receiver report). */
  noLossStreak: number;
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
  };
}

/** A rung change the ladder decided, with what decided it (for the one log line). */
export interface VideoQualityChange {
  from: number;
  to: number;
  direction: 'down' | 'up';
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
  /** Set ONCE, the sample the loss figure has been missing `NO_LOSS_REPORT_WARN_AFTER` times. */
  noLossReport: boolean;
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
  if (state.settling) {
    return { state: { ...state, settling: false }, change: null, noLossReport: false };
  }
  const noLossStreak = ev.loss === null ? state.noLossStreak + 1 : 0;
  const noLossReport = noLossStreak === NO_LOSS_REPORT_WARN_AFTER;
  const probe =
    state.probe && state.probe.samples < PROBE_WATCH
      ? { ...state.probe, samples: state.probe.samples + 1 }
      : null;
  const v = judgeVideoEvidence(state.rung, ev);
  const base = { ...state, probe, noLossStreak };

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

  if (v.verdict === 'good') {
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

/** `loss=4% rtt=120ms limit=bandwidth avail=850kbps sent=610kbps`, `?` for what is unknown. */
export function describeVideoEvidence(ev: VideoEvidence): string {
  const kbps = (v: number | null) => (v === null ? '?' : `${Math.round(v / 1000)}kbps`);
  const loss = ev.loss === null ? '?' : `${Math.round(ev.loss * 100)}%`;
  const rtt = ev.rtt === null ? '?' : `${Math.round(ev.rtt * 1000)}ms`;
  return `loss=${loss} rtt=${rtt} limit=${ev.limit ?? '?'} avail=${kbps(ev.available)} sent=${kbps(ev.sentBitrate)}`;
}

/** The one log line of a rung change. */
export function describeVideoQualityChange(c: VideoQualityChange): string {
  const from = CALL_VIDEO_LADDER[c.from].name;
  const to = CALL_VIDEO_LADDER[c.to].name;
  const how =
    c.direction === 'down'
      ? `${c.severe ? 'a severe sample' : `${c.samples} bad samples`}${c.probeFailed ? `, the climb into ${from} failed - the next one needs ${c.nextRequired} clean samples` : ''}`
      : `${c.samples} clean samples`;
  return `video quality ${c.direction} ${from} -> ${to} after ${how} (${describeVideoEvidence(c.evidence)})`;
}
