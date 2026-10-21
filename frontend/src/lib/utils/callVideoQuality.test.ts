import { describe, expect, it, vi } from 'vitest';
import {
  CALL_VIDEO_LADDER,
  CALL_VIDEO_RELAY_TOP_RUNG,
  CALL_VIDEO_START_RUNG,
  CallVideoQualityLoop,
  DOWN_AFTER_BAD,
  MAX_REQUIRED_GOOD,
  MIN_PACKETS_FOR_LOSS,
  NO_LOSS_REPORT_WARN_AFTER,
  PROBE_WATCH,
  UP_AFTER_GOOD,
  describeVideoEvidence,
  describeVideoQualityChange,
  initialVideoQuality,
  judgeVideoEvidence,
  readVideoSendSample,
  stepVideoQuality,
  videoEvidence,
  type VideoEvidence,
  type VideoQualityChange,
  type VideoQualityState,
  type VideoSendSample,
} from './callVideoQuality';
import { applyCallVideoRung, callVideoConstraints } from './callVideo';

const report = (entries: Record<string, unknown>[]) =>
  new Map(entries.map((e) => [e.id as string, e])) as unknown as RTCStatsReport;

/** A clean sample of a direct link that carries everything, the encoder mostly idle. */
const CLEAN: VideoEvidence = {
  loss: 0,
  rtt: 0.04,
  available: 5_000_000,
  limit: 'none',
  sentBitrate: null,
  encodeShare: 0.05,
  relayed: false,
};
const LOSSY: VideoEvidence = { ...CLEAN, loss: 0.12, rtt: 0.1 };

/** Steps the ladder through `evs` in order and returns the last state and every change. */
function run(state: VideoQualityState, evs: (VideoEvidence | null)[]) {
  const changes: VideoQualityChange[] = [];
  for (const ev of evs) {
    const step = stepVideoQuality(state, ev);
    state = step.state;
    if (step.change) changes.push(step.change);
  }
  return { state, changes };
}

describe('the ladder', () => {
  it('is ordered top first, each need carried by the ceiling of the rung below', () => {
    for (let i = 1; i < CALL_VIDEO_LADDER.length; i++) {
      const up = CALL_VIDEO_LADDER[i - 1];
      const here = CALL_VIDEO_LADDER[i];
      expect(here.maxBitrate).toBeLessThan(up.maxBitrate);
      expect(up.needBitrate).toBeLessThanOrEqual(here.maxBitrate);
      expect(here.scaleResolutionDownBy).toBeGreaterThanOrEqual(up.scaleResolutionDownBy);
      expect(here.maxFramerate).toBeLessThanOrEqual(up.maxFramerate);
    }
    expect(CALL_VIDEO_LADDER[0]).toMatchObject({ scaleResolutionDownBy: 1, maxFramerate: 30 });
    expect(CALL_VIDEO_LADDER[0].maxBitrate).toBeGreaterThanOrEqual(1_500_000);
    expect(CALL_VIDEO_LADDER[0].maxBitrate).toBeLessThanOrEqual(2_500_000);
    expect(CALL_VIDEO_LADDER.at(-1)!.needBitrate).toBe(0);
  });

  it('asks the camera for 720p at 30 fps as IDEALS - no max a portrait camera could trip on', () => {
    const c = callVideoConstraints('user');
    expect(c).toMatchObject({ width: { ideal: 1280 }, height: { ideal: 720 } });
    expect(c.width).not.toHaveProperty('max');
    expect(c.height).not.toHaveProperty('max');
    expect(c.frameRate).toEqual({ ideal: 30, max: 30 });
  });
});

describe('readVideoSendSample', () => {
  it('reads the outbound video, the peer report and the selected pair', () => {
    const s = readVideoSendSample(
      report([
        { id: 'oa', type: 'outbound-rtp', kind: 'audio', packetsSent: 999 },
        {
          id: 'ov',
          type: 'outbound-rtp',
          kind: 'video',
          framesEncoded: 300,
          packetsSent: 900,
          bytesSent: 1_000_000,
          totalEncodeTime: 1.5,
          frameWidth: 1280,
          frameHeight: 720,
          framesPerSecond: 30,
          qualityLimitationReason: 'none',
          timestamp: 5000,
        },
        { id: 'ra', type: 'remote-inbound-rtp', kind: 'audio', localId: 'oa', packetsLost: 77 },
        {
          id: 'rv',
          type: 'remote-inbound-rtp',
          kind: 'video',
          localId: 'ov',
          packetsLost: 4,
          roundTripTime: 0.05,
          reportsReceived: 12,
          timestamp: 4900,
        },
        { id: 't', type: 'transport', selectedCandidatePairId: 'p' },
        {
          id: 'p',
          type: 'candidate-pair',
          availableOutgoingBitrate: 2_000_000,
          currentRoundTripTime: 0.04,
          localCandidateId: 'lc',
          remoteCandidateId: 'rc',
        },
        { id: 'lc', type: 'local-candidate', candidateType: 'host' },
        { id: 'rc', type: 'remote-candidate', candidateType: 'srflx' },
      ])
    );
    expect(s).toEqual({
      framesEncoded: 300,
      packetsSent: 900,
      packetsLost: 4,
      remoteReports: 12,
      remoteTimestamp: 4900,
      remoteRtt: 0.05,
      pairRtt: 0.04,
      availableOutgoingBitrate: 2_000_000,
      qualityLimitationReason: 'none',
      bytesSent: 1_000_000,
      totalEncodeTime: 1.5,
      frameWidth: 1280,
      frameHeight: 720,
      framesPerSecond: 30,
      timestamp: 5000,
      relayed: false,
    });
  });

  it('reads a TURN relay on either end of the pair (Gecko marks the pair selected)', () => {
    const s = readVideoSendSample(
      report([
        { id: 'ov', type: 'outbound-rtp', mediaType: 'video', framesEncoded: 1 },
        {
          id: 'p',
          type: 'candidate-pair',
          selected: true,
          localCandidateId: 'lc',
          remoteCandidateId: 'rc',
        },
        { id: 'lc', type: 'local-candidate', candidateType: 'relay' },
        { id: 'rc', type: 'remote-candidate', candidateType: 'host' },
      ])
    );
    expect(s).toMatchObject({ relayed: true, packetsLost: null, remoteReports: null });
  });

  it('says nothing of a relay before a pair is selected, and is null without outbound video', () => {
    expect(
      readVideoSendSample(report([{ id: 'ov', type: 'outbound-rtp', kind: 'video' }]))?.relayed
    ).toBe(null);
    expect(readVideoSendSample(report([{ id: 'oa', type: 'outbound-rtp', kind: 'audio' }]))).toBe(
      null
    );
  });
});

const sample = (o: Partial<VideoSendSample>): VideoSendSample => ({
  framesEncoded: 0,
  packetsSent: 0,
  packetsLost: 0,
  remoteReports: 0,
  remoteTimestamp: null,
  remoteRtt: null,
  pairRtt: null,
  availableOutgoingBitrate: null,
  qualityLimitationReason: null,
  bytesSent: null,
  totalEncodeTime: null,
  frameWidth: null,
  frameHeight: null,
  framesPerSecond: null,
  timestamp: null,
  relayed: null,
  ...o,
});

describe('videoEvidence', () => {
  it('reads loss, rate sent and encode load between two samples when the peer report moved', () => {
    const ev = videoEvidence(
      sample({
        framesEncoded: 10,
        packetsSent: 100,
        packetsLost: 2,
        remoteReports: 3,
        bytesSent: 0,
        totalEncodeTime: 1,
        timestamp: 1000,
      }),
      sample({
        framesEncoded: 70,
        packetsSent: 300,
        packetsLost: 22,
        remoteReports: 5,
        remoteRtt: 0.1,
        availableOutgoingBitrate: 900_000,
        qualityLimitationReason: 'bandwidth',
        bytesSent: 250_000,
        totalEncodeTime: 1.5,
        timestamp: 3000,
        relayed: false,
      })
    );
    expect(ev).toEqual({
      loss: 0.1,
      rtt: 0.1,
      available: 900_000,
      limit: 'bandwidth',
      sentBitrate: 1_000_000,
      encodeShare: 0.25,
      relayed: false,
    });
  });

  it('a receiver report that did NOT move gives no loss and no round trip - never 0 % in an outage', () => {
    const prev = sample({ framesEncoded: 1, packetsSent: 0, packetsLost: 5, remoteReports: 7 });
    const frozen = sample({
      framesEncoded: 60,
      packetsSent: 400,
      packetsLost: 5,
      remoteReports: 7,
      remoteRtt: 0.05,
      pairRtt: 0.05,
    });
    expect(videoEvidence(prev, frozen)).toMatchObject({ loss: null, rtt: null });
    // An engine that counts no reports: its timestamp says whether the report is new.
    const p2 = sample({ framesEncoded: 1, remoteReports: null, remoteTimestamp: 900 });
    const same = sample({
      framesEncoded: 2,
      packetsSent: 400,
      remoteReports: null,
      remoteTimestamp: 900,
      remoteRtt: 0.05,
    });
    expect(videoEvidence(p2, same)).toMatchObject({ loss: null, rtt: null });
    expect(videoEvidence(p2, { ...same, remoteTimestamp: 2900 })).toMatchObject({
      loss: 0,
      rtt: 0.05,
    });
  });

  it('takes the pair round trip only when the peer sends no report at all', () => {
    const none = { remoteReports: null, remoteTimestamp: null, pairRtt: 0.03 };
    const ev = videoEvidence(
      sample({ framesEncoded: 1, ...none }),
      sample({ framesEncoded: 2, ...none })
    );
    expect(ev).toMatchObject({ rtt: 0.03, loss: null });
  });

  it('is no evidence without a baseline, or when nothing was encoded since', () => {
    expect(videoEvidence(null, sample({ framesEncoded: 5 }))).toBe(null);
    expect(videoEvidence(sample({ framesEncoded: 5 }), null)).toBe(null);
    expect(videoEvidence(sample({ framesEncoded: 5 }), sample({ framesEncoded: 5 }))).toBe(null);
    expect(videoEvidence(sample({ framesEncoded: null }), sample({ framesEncoded: 5 }))).toBe(null);
  });

  it('gives no loss over too few packets, and clamps it to [0, 1]', () => {
    const few = videoEvidence(
      sample({ framesEncoded: 1, packetsSent: 0 }),
      sample({
        framesEncoded: 2,
        packetsSent: MIN_PACKETS_FOR_LOSS - 1,
        packetsLost: 5,
        remoteReports: 1,
      })
    );
    expect(few?.loss).toBe(null);
    const backwards = videoEvidence(
      sample({ framesEncoded: 1, packetsSent: 0, packetsLost: 10 }),
      sample({ framesEncoded: 2, packetsSent: 100, packetsLost: 4, remoteReports: 1 })
    );
    expect(backwards?.loss).toBe(0);
  });

  it('gives no rate and no encode load without a forward timestamp', () => {
    const a = sample({ framesEncoded: 1, bytesSent: 0, totalEncodeTime: 0, timestamp: 1000 });
    const ev = (b: Partial<VideoSendSample>) =>
      videoEvidence(a, sample({ framesEncoded: 2, ...b }));
    expect(ev({ bytesSent: 10, totalEncodeTime: 1, timestamp: 1000 })).toMatchObject({
      sentBitrate: null,
      encodeShare: null,
    });
    expect(ev({ bytesSent: null, timestamp: 2000 })?.sentBitrate).toBe(null);
    expect(ev({ bytesSent: 10, timestamp: null })?.sentBitrate).toBe(null);
  });
});

describe('judgeVideoEvidence', () => {
  it('reads a clean link as good below the top, steady at the top', () => {
    expect(judgeVideoEvidence(1, CLEAN).verdict).toBe('good');
    expect(judgeVideoEvidence(0, CLEAN).verdict).toBe('steady');
  });

  it.each([
    ['loss', { ...CLEAN, loss: 0.1 }],
    ['round trip', { ...CLEAN, rtt: 0.8 }],
    ['cpu, the encoder busy half the time', { ...CLEAN, limit: 'cpu', encodeShare: 0.5 }],
    ['bandwidth, estimate under the need', { ...CLEAN, limit: 'bandwidth', available: 1_000_000 }],
  ])('reads %s as bad, one rung down at least', (_, ev) => {
    const v = judgeVideoEvidence(0, ev as VideoEvidence);
    expect(v.verdict).toBe('bad');
    expect(v.target).toBeGreaterThanOrEqual(1);
  });

  it.each([
    ['a low estimate alone (a still scene)', { ...CLEAN, available: 200_000 }],
    ['bandwidth with an UNKNOWN estimate', { ...CLEAN, limit: 'bandwidth', available: null }],
    [
      'bandwidth with an estimate that carries the rung',
      { ...CLEAN, limit: 'bandwidth', available: 2_000_000 },
    ],
    ['a lingering cpu state, the encoder idle', { ...CLEAN, limit: 'cpu', encodeShare: 0.1 }],
    ['cpu with no encode time measured', { ...CLEAN, limit: 'cpu', encodeShare: null }],
    ['a heavy encode the encoder does not call cpu', { ...CLEAN, encodeShare: 0.9 }],
  ])('never drops on %s', (_, ev) => {
    expect(judgeVideoEvidence(0, ev as VideoEvidence).verdict).toBe('steady');
  });

  it('drops a bandwidth-starved encoder straight to the rung the estimate carries', () => {
    const v = judgeVideoEvidence(0, { ...CLEAN, limit: 'bandwidth', available: 300_000 });
    expect(v).toEqual({ verdict: 'bad', severe: true, target: 3 });
    expect(judgeVideoEvidence(0, { ...CLEAN, limit: 'bandwidth', available: 1 }).target).toBe(
      CALL_VIDEO_LADDER.length - 1
    );
  });

  it.each([
    ['loss', { ...CLEAN, loss: 0.25 }],
    ['round trip', { ...CLEAN, rtt: 1.5 }],
    ['estimate under half the need', { ...CLEAN, limit: 'bandwidth', available: 500_000 }],
  ])('reads severe %s as severe', (_, ev) => {
    expect(judgeVideoEvidence(0, ev as VideoEvidence).severe).toBe(true);
  });

  it.each([
    ['unknown loss (no fresh report)', { ...CLEAN, loss: null }],
    ['an unknown round trip (no fresh report)', { ...CLEAN, rtt: null }],
    ['loss at the clean bound', { ...CLEAN, loss: 0.03 }],
    ['a round trip at the clean bound', { ...CLEAN, rtt: 0.35 }],
    ['an encoder limited by bandwidth', { ...CLEAN, limit: 'bandwidth' }],
    ['an encoder limited otherwise', { ...CLEAN, limit: 'other' }],
    ['a cpu state with the encoder still busy', { ...CLEAN, limit: 'cpu', encodeShare: 0.4 }],
    ['an estimate under the rung above', { ...CLEAN, available: 1_000_000 }],
    ['no limit reported and no estimate', { ...CLEAN, limit: null, available: null }],
  ])('does not climb on %s', (_, ev) => {
    expect(judgeVideoEvidence(1, ev as VideoEvidence).verdict).toBe('steady');
  });

  it('climbs on HEADROOM: a cheap scene whose estimate stands well above what it sends', () => {
    // Measured in the rig: a scene sending ~670 kb/s at 480p kept its estimate under 720p's need.
    const cheap = { ...CLEAN, available: 1_000_000, sentBitrate: 670_000 };
    expect(judgeVideoEvidence(1, cheap).verdict).toBe('good');
    // A full link: the estimate is what is sent - no room, no climb.
    expect(judgeVideoEvidence(1, { ...cheap, sentBitrate: 950_000 }).verdict).toBe('steady');
    expect(judgeVideoEvidence(1, { ...cheap, sentBitrate: 0 }).verdict).toBe('steady');
    expect(judgeVideoEvidence(1, { ...cheap, limit: null }).verdict).toBe('good');
  });

  it('climbs past a stale `bandwidth` only when the estimate shows the rung above AND room', () => {
    // Measured in the rig after a camera switch: `bandwidth` for the whole call, 2.97 Mb/s estimated.
    const stale = { ...CLEAN, limit: 'bandwidth', available: 2_970_000, sentBitrate: 700_000 };
    expect(judgeVideoEvidence(1, stale).verdict).toBe('good');
    expect(judgeVideoEvidence(1, { ...stale, sentBitrate: 2_500_000 }).verdict).toBe('steady');
    expect(
      judgeVideoEvidence(1, { ...stale, available: 1_000_000, sentBitrate: 500_000 }).verdict
    ).toBe('steady');
  });

  it('climbs past a stale `cpu` only with the encoder mostly idle and room on the link', () => {
    const idle = { ...CLEAN, limit: 'cpu', encodeShare: 0.1, sentBitrate: 700_000 };
    expect(judgeVideoEvidence(1, idle).verdict).toBe('good');
    expect(judgeVideoEvidence(1, { ...idle, encodeShare: null }).verdict).toBe('steady');
  });

  it('cannot go below the bottom', () => {
    const last = CALL_VIDEO_LADDER.length - 1;
    expect(judgeVideoEvidence(last, LOSSY)).toMatchObject({ verdict: 'bad', target: last });
  });
});

describe('stepVideoQuality', () => {
  it('starts one rung under the top and climbs after UP_AFTER_GOOD clean samples', () => {
    const start = initialVideoQuality();
    expect(start.rung).toBe(CALL_VIDEO_START_RUNG);
    const { state, changes } = run(start, Array(UP_AFTER_GOOD).fill(CLEAN));
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ from: 1, to: 0, direction: 'up', samples: UP_AFTER_GOOD });
    expect(state).toMatchObject({ rung: 0, settling: true, probe: { to: 0, samples: 0 } });
  });

  it('needs CONSECUTIVE clean samples: a steady one restarts the count', () => {
    const steady = { ...CLEAN, limit: 'bandwidth' };
    const { changes } = run(initialVideoQuality(), [CLEAN, CLEAN, steady, CLEAN, CLEAN]);
    expect(changes).toHaveLength(0);
  });

  it('a frozen receiver report never climbs, however long it stays frozen', () => {
    const frozen = { ...CLEAN, loss: null, rtt: null };
    expect(run(initialVideoQuality(), Array(50).fill(frozen)).changes).toHaveLength(0);
  });

  it('drops after DOWN_AFTER_BAD bad samples, not one', () => {
    const one = run(initialVideoQuality(0), [LOSSY]);
    expect(one.changes).toHaveLength(0);
    expect(one.state.badStreak).toBe(1);
    const two = run(initialVideoQuality(0), Array(DOWN_AFTER_BAD).fill(LOSSY));
    expect(two.changes).toMatchObject([{ from: 0, to: 1, direction: 'down', severe: false }]);
  });

  it('drops at once on a severe sample, as far as the estimate says', () => {
    const { changes } = run(initialVideoQuality(0), [
      { ...CLEAN, limit: 'bandwidth', available: 190_000 },
    ]);
    expect(changes).toMatchObject([{ from: 0, to: 3, severe: true }]);
  });

  it('a cpu state that PERSISTS after its drop costs exactly one rung (the lighter rung relieves the encoder)', () => {
    const overloaded = { ...CLEAN, limit: 'cpu', encodeShare: 0.7 };
    // After the drop libwebrtc keeps saying `cpu`, but the smaller picture encodes in less time.
    const lingering = { ...CLEAN, limit: 'cpu', encodeShare: 0.35 };
    const { state, changes } = run(initialVideoQuality(0), [
      overloaded,
      overloaded,
      ...Array(40).fill(lingering),
    ]);
    expect(changes).toMatchObject([{ from: 0, to: 1, direction: 'down' }]);
    expect(state.rung).toBe(1);
  });

  it('a bad sample between two others is not a streak', () => {
    const { changes } = run(initialVideoQuality(0), [LOSSY, CLEAN, LOSSY, CLEAN]);
    expect(changes).toHaveLength(0);
  });

  it('reads the sample after a change without judging it (it straddles the new encoding)', () => {
    let { state } = run(initialVideoQuality(0), [LOSSY, LOSSY]);
    expect(state.settling).toBe(true);
    const step = stepVideoQuality(state, LOSSY);
    expect(step.change).toBe(null);
    state = step.state;
    expect(state).toMatchObject({ settling: false, badStreak: 0, rung: 1 });
  });

  it('no evidence (camera off) moves nothing and breaks both streaks', () => {
    const { state, changes } = run(initialVideoQuality(0), [LOSSY, null, LOSSY]);
    expect(changes).toHaveLength(0);
    expect(state.badStreak).toBe(1);
    const up = run(initialVideoQuality(), [CLEAN, CLEAN, null, CLEAN]);
    expect(up.changes).toHaveLength(0);
  });

  it('holds the bottom on bad samples and the top on clean ones', () => {
    const last = CALL_VIDEO_LADDER.length - 1;
    expect(run(initialVideoQuality(last), Array(10).fill(LOSSY)).changes).toHaveLength(0);
    expect(run(initialVideoQuality(0), Array(10).fill(CLEAN)).changes).toHaveLength(0);
  });

  it('a climb that falls back within PROBE_WATCH samples doubles the next climb into that rung', () => {
    // 480p -> 720p, the settling sample, then the link cannot hold it.
    const evs = [...Array(UP_AFTER_GOOD).fill(CLEAN), CLEAN, LOSSY, LOSSY];
    const { state, changes } = run(initialVideoQuality(), evs);
    expect(changes.map((c) => [c.direction, c.to])).toEqual([
      ['up', 0],
      ['down', 1],
    ]);
    expect(changes[1]).toMatchObject({ probeFailed: true, nextRequired: UP_AFTER_GOOD * 2 });
    expect(state.required[0]).toBe(UP_AFTER_GOOD * 2);
    const again = run(state, [CLEAN, ...Array(UP_AFTER_GOOD * 2 - 1).fill(CLEAN)]);
    expect(again.changes).toHaveLength(0);
    expect(run(again.state, [CLEAN]).changes).toMatchObject([{ direction: 'up', to: 0 }]);
  });

  it('a drop long after a climb is the link changing, not a failed probe', () => {
    const evs = [
      ...Array(UP_AFTER_GOOD).fill(CLEAN),
      CLEAN, // settling
      ...Array(PROBE_WATCH).fill(CLEAN),
      LOSSY,
      LOSSY,
    ];
    const { state, changes } = run(initialVideoQuality(), evs);
    expect(changes.at(-1)).toMatchObject({ direction: 'down', probeFailed: false });
    expect(state.required[0]).toBe(UP_AFTER_GOOD);
  });

  it('caps the required count at MAX_REQUIRED_GOOD however often the climb fails', () => {
    let state = initialVideoQuality();
    for (let i = 0; i < 10; i++) {
      const climb = run(state, [CLEAN, ...Array(state.required[0]).fill(CLEAN)]);
      expect(climb.changes.some((c) => c.direction === 'up')).toBe(true);
      state = run(climb.state, [CLEAN, LOSSY, LOSSY]).state;
      expect(state.rung).toBe(1);
    }
    expect(state.required[0]).toBe(MAX_REQUIRED_GOOD);
  });

  it('SIMULATION: a link that holds 720p for ~16 s then loses does not cycle every 20 s for the whole call', () => {
    // The link: 720p is clean for 8 samples after each climb, then two lossy ones; 480p is clean.
    let state = initialVideoQuality();
    let atRung = 0;
    const climbs: number[] = [];
    for (let t = 0; t < 300; t++) {
      const ev = state.rung === 0 ? (atRung < 9 ? CLEAN : LOSSY) : CLEAN;
      const step = stepVideoQuality(state, ev);
      if (step.change) {
        if (step.change.direction === 'up') climbs.push(t);
        atRung = 0;
      } else {
        atRung += 1;
      }
      state = step.state;
    }
    // Ten minutes: a handful of probes, each one further apart than the last.
    expect(climbs.length).toBeLessThanOrEqual(8);
    const gaps = climbs.slice(1).map((t, i) => t - climbs[i]);
    for (let i = 1; i < gaps.length; i++) expect(gaps[i]).toBeGreaterThanOrEqual(gaps[i - 1]);
    expect(gaps.at(-1)).toBeGreaterThanOrEqual(MAX_REQUIRED_GOOD);
  });

  it('says ONCE per ladder that the peer sends no fresh loss figure, even after one came back', () => {
    const noLoss = { ...CLEAN, loss: null };
    let state = initialVideoQuality();
    const said: number[] = [];
    const evs = [
      ...Array(NO_LOSS_REPORT_WARN_AFTER * 2).fill(noLoss),
      { ...CLEAN, limit: 'other' },
      ...Array(NO_LOSS_REPORT_WARN_AFTER * 2).fill(noLoss),
    ];
    evs.forEach((ev, i) => {
      const step = stepVideoQuality(state, ev);
      state = step.state;
      if (step.noLossReport) said.push(i + 1);
    });
    expect(said).toEqual([NO_LOSS_REPORT_WARN_AFTER]);
    expect(state.rung).toBe(CALL_VIDEO_START_RUNG);
  });

  it('a RELAYED call is brought down to its cap at once and never climbs above it', () => {
    const relayed = { ...CLEAN, relayed: true };
    const down = run(initialVideoQuality(0), [relayed]);
    expect(down.changes).toMatchObject([
      { from: 0, to: CALL_VIDEO_RELAY_TOP_RUNG, direction: 'down', cause: 'relay' },
    ]);
    expect(run(initialVideoQuality(), Array(60).fill(relayed)).changes).toHaveLength(0);
    // Back on a direct path, the climb is open again.
    const direct = run(initialVideoQuality(), Array(UP_AFTER_GOOD).fill(CLEAN));
    expect(direct.state.rung).toBe(0);
  });

  it('walks a weakening link down and a recovering one back up', () => {
    const weak = { ...CLEAN, loss: 0.15, rtt: 0.5, available: 250_000, limit: 'bandwidth' };
    const down = run(initialVideoQuality(0), [weak, weak, weak]);
    expect(down.state.rung).toBe(3);
    const up = run(down.state, Array(40).fill(CLEAN));
    expect(up.state.rung).toBe(0);
    expect(up.changes.map((c) => c.to)).toEqual([2, 1, 0]);
  });

  it('does not mutate the state it was given', () => {
    const state = initialVideoQuality();
    const copy = structuredClone(state);
    run(state, [LOSSY, LOSSY, CLEAN, CLEAN, CLEAN, null]);
    expect(state).toEqual(copy);
  });
});

describe('the log line', () => {
  it('names the rungs, the streak and the evidence', () => {
    const { changes } = run(initialVideoQuality(0), [LOSSY, LOSSY]);
    expect(describeVideoQualityChange(changes[0])).toBe(
      'video quality down 720p30 -> 480p30 after 2 bad samples (loss=12% rtt=100ms limit=none avail=5000kbps sent=? enc=5%)'
    );
    const failed = run(initialVideoQuality(), [
      ...Array(UP_AFTER_GOOD).fill(CLEAN),
      CLEAN,
      { ...CLEAN, loss: 0.3 },
    ]).changes[1];
    expect(describeVideoQualityChange(failed)).toBe(
      `video quality down 720p30 -> 480p30 after a severe sample, the climb into 720p30 failed - the next one needs ${UP_AFTER_GOOD * 2} clean samples (loss=30% rtt=40ms limit=none avail=5000kbps sent=? enc=5%)`
    );
    const relay = run(initialVideoQuality(0), [{ ...CLEAN, relayed: true }]).changes[0];
    expect(describeVideoQualityChange(relay)).toBe(
      'video quality down 720p30 -> 480p30 after the call went through a TURN relay (capped) (loss=0% rtt=40ms limit=none avail=5000kbps sent=? enc=5% relayed)'
    );
  });

  it('writes ? for what a sample could not say', () => {
    expect(
      describeVideoEvidence({
        loss: null,
        rtt: null,
        available: null,
        limit: null,
        sentBitrate: null,
        encodeShare: null,
        relayed: null,
      })
    ).toBe('loss=? rtt=? limit=? avail=? sent=? enc=?');
  });
});

describe('applyCallVideoRung', () => {
  it('sets the rung on the first encoding and says so', async () => {
    const params = { encodings: [] as RTCRtpEncodingParameters[] };
    const setParameters = vi.fn(async () => {});
    const sender = { getParameters: () => params, setParameters } as unknown as RTCRtpSender;
    const log = vi.fn();
    expect(await applyCallVideoRung(sender, CALL_VIDEO_LADDER[2], log)).toBe(true);
    expect(setParameters).toHaveBeenCalledWith({
      encodings: [{ maxBitrate: 700_000, maxFramerate: 30, scaleResolutionDownBy: 2 }],
    });
    expect(log).toHaveBeenCalledWith(
      '[Call] video sender on 360p30 (scale 2, 30 fps, max 700 kbps)'
    );
  });

  it('returns false and logs an ERROR when the engine refuses', async () => {
    const sender = {
      getParameters: () => ({ encodings: [{}] }),
      setParameters: async () => {
        throw new Error('InvalidModificationError');
      },
    } as unknown as RTCRtpSender;
    const log = vi.fn();
    expect(await applyCallVideoRung(sender, CALL_VIDEO_LADDER[0], log)).toBe(false);
    expect(log).toHaveBeenCalledWith(
      '[Call] ERROR video sender setParameters(720p30) refused: Error: InvalidModificationError'
    );
  });
});

describe('CallVideoQualityLoop', () => {
  /** The stats of a direct, clean link at sample `n` (cumulative counters, 2 s apart). */
  function statsAt(n: number, o: { lossPerSample?: number; relay?: boolean } = {}) {
    return report([
      {
        id: 'ov',
        type: 'outbound-rtp',
        kind: 'video',
        framesEncoded: n * 60,
        packetsSent: n * 400,
        bytesSent: n * 150_000,
        totalEncodeTime: n * 0.1,
        qualityLimitationReason: 'none',
        timestamp: n * 2000,
      },
      {
        id: 'rv',
        type: 'remote-inbound-rtp',
        kind: 'video',
        localId: 'ov',
        packetsLost: Math.round(n * 400 * (o.lossPerSample ?? 0)),
        roundTripTime: 0.05,
        reportsReceived: n,
      },
      { id: 't', type: 'transport', selectedCandidatePairId: 'p' },
      {
        id: 'p',
        type: 'candidate-pair',
        availableOutgoingBitrate: 5_000_000,
        localCandidateId: 'lc',
        remoteCandidateId: 'rc',
      },
      { id: 'lc', type: 'local-candidate', candidateType: o.relay ? 'relay' : 'host' },
      { id: 'rc', type: 'remote-candidate', candidateType: 'host' },
    ]);
  }

  /** A loop on a fake sender and a hand-driven timer; `tick()` fires the pending sample. */
  function harness(opts: { refuse?: 'start' | 'change' } = {}) {
    let n = 0;
    let loss = 0;
    const timers = new Map<number, () => void>();
    let nextId = 1;
    const logs: string[] = [];
    const reduced: boolean[] = [];
    let params: { encodings: Record<string, unknown>[] } = { encodings: [{}] };
    let calls = 0;
    const sender = {
      track: { kind: 'video' } as unknown,
      getParameters: () => structuredClone(params),
      setParameters: vi.fn(async (p: typeof params) => {
        calls += 1;
        if (opts.refuse === 'start' || (opts.refuse === 'change' && calls > 1)) {
          throw new Error('InvalidModificationError');
        }
        params = p;
      }),
    };
    const loop = new CallVideoQualityLoop({
      pc: { getStats: async () => statsAt(n, { lossPerSample: loss }) },
      sender: sender as unknown as RTCRtpSender,
      log: (m) => logs.push(m),
      onReduced: (r) => reduced.push(r),
      setTimer: (fn) => {
        timers.set(nextId, fn);
        return nextId++;
      },
      clearTimer: (id) => timers.delete(id),
    });
    const settle = async () => {
      for (let i = 0; i < 20; i++) await Promise.resolve();
    };
    const tick = async () => {
      n += 1;
      const [id, fn] = [...timers.entries()][0] ?? [];
      if (id === undefined || !fn) return false;
      timers.delete(id);
      fn();
      await settle();
      return true;
    };
    return {
      loop,
      sender,
      logs,
      reduced,
      timers,
      tick,
      settle,
      params: () => params.encodings[0],
      setLoss: (l: number) => (loss = l),
    };
  }

  it('starts on 480p, says its degradationPreference, and climbs to 720p on a clean link', async () => {
    const h = harness();
    h.loop.start();
    await h.settle();
    expect(h.logs[0]).toBe(
      '[Call] video quality ladder starts on 480p30 (degradationPreference=unset)'
    );
    expect(h.params()).toMatchObject({ scaleResolutionDownBy: 1.5, maxBitrate: 1_200_000 });
    expect(h.reduced).toEqual([false]);
    for (let i = 0; i < 4; i++) await h.tick();
    expect(h.loop.rung).toBe(0);
    expect(h.params()).toMatchObject({ scaleResolutionDownBy: 1, maxBitrate: 2_500_000 });
    expect(h.loop.changes.map((c) => c.to)).toEqual([0]);
  });

  it('stops its timer while the camera is off, and resume() samples again from a new baseline', async () => {
    const h = harness();
    h.loop.start();
    await h.settle();
    await h.tick();
    h.sender.track = null;
    await h.tick();
    expect(h.timers.size).toBe(0);
    h.sender.track = { kind: 'video' };
    h.loop.resume();
    expect(h.timers.size).toBe(1);
    h.loop.resume();
    expect(h.timers.size).toBe(1);
  });

  it('a rung refused at the start: ERROR, "not started", no timer left and nothing said reduced', async () => {
    const h = harness({ refuse: 'start' });
    h.loop.start();
    await h.settle();
    expect(h.logs).toContain(
      '[Call] ERROR video quality ladder not started: the sender refused 480p30'
    );
    expect(h.loop.running).toBe(false);
    expect(h.timers.size).toBe(0);
    expect(h.reduced).toEqual([]);
  });

  it('a rung refused later stops the loop and leaves the reduced flag as the sender still is', async () => {
    const h = harness({ refuse: 'change' });
    h.loop.start();
    await h.settle();
    await h.tick();
    h.setLoss(0.3);
    await h.tick();
    expect(h.logs).toContain(
      '[Call] ERROR video quality ladder stopped: the sender refused a rung'
    );
    expect(h.loop.running).toBe(false);
    expect(h.loop.rung).toBe(1);
    expect(h.reduced).toEqual([false]);
    expect(await h.tick()).toBe(false);
  });

  it('a relayed call never sends above 480p', async () => {
    const h = harness();
    const relayed = new CallVideoQualityLoop({
      pc: { getStats: async () => statsAt(++relayN, { relay: true }) },
      sender: h.sender as unknown as RTCRtpSender,
      log: () => {},
      onReduced: () => {},
      setTimer: (fn) => {
        h.timers.set(99, fn);
        return 99;
      },
      clearTimer: () => h.timers.clear(),
    });
    let relayN = 0;
    relayed.start();
    await h.settle();
    for (let i = 0; i < 20; i++) {
      const fn = h.timers.get(99);
      h.timers.delete(99);
      fn?.();
      await h.settle();
    }
    expect(relayed.rung).toBe(CALL_VIDEO_RELAY_TOP_RUNG);
    expect(relayed.changes).toEqual([]);
  });
});
