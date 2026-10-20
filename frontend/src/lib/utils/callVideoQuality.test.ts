import { describe, expect, it, vi } from 'vitest';
import {
  CALL_VIDEO_LADDER,
  CALL_VIDEO_START_RUNG,
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
  type VideoQualityState,
  type VideoSendSample,
} from './callVideoQuality';
import { applyCallVideoRung, callVideoConstraints } from './callVideo';

const report = (entries: Record<string, unknown>[]) =>
  new Map(entries.map((e) => [e.id as string, e])) as unknown as RTCStatsReport;

/** A clean sample of a link that carries everything. */
const CLEAN: VideoEvidence = {
  loss: 0,
  rtt: 0.04,
  available: 5_000_000,
  limit: 'none',
  sentBitrate: null,
};
const LOSSY: VideoEvidence = { ...CLEAN, loss: 0.12, rtt: 0.1 };

/** Steps the ladder through `evs` in order and returns every state and change. */
function run(state: VideoQualityState, evs: (VideoEvidence | null)[]) {
  const changes = [];
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

  it('captures the top rung: 1280x720 at 30 fps', () => {
    expect(callVideoConstraints('user')).toMatchObject({
      width: { ideal: 1280, max: 1280 },
      height: { ideal: 720, max: 720 },
      frameRate: { ideal: 30, max: 30 },
    });
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
        },
        { id: 't', type: 'transport', selectedCandidatePairId: 'p' },
        { id: 'p', type: 'candidate-pair', availableOutgoingBitrate: 2_000_000 },
      ])
    );
    expect(s).toEqual({
      framesEncoded: 300,
      packetsSent: 900,
      packetsLost: 4,
      rtt: 0.05,
      availableOutgoingBitrate: 2_000_000,
      qualityLimitationReason: 'none',
      bytesSent: 1_000_000,
      totalEncodeTime: 1.5,
      frameWidth: 1280,
      frameHeight: 720,
      framesPerSecond: 30,
      timestamp: 5000,
    });
  });

  it('takes the pair marked selected (Gecko) and its RTT when the peer reports none', () => {
    const s = readVideoSendSample(
      report([
        { id: 'ov', type: 'outbound-rtp', mediaType: 'video', framesEncoded: 1 },
        {
          id: 'p',
          type: 'candidate-pair',
          selected: true,
          currentRoundTripTime: 0.2,
          availableOutgoingBitrate: 300_000,
        },
      ])
    );
    expect(s).toMatchObject({
      rtt: 0.2,
      availableOutgoingBitrate: 300_000,
      packetsLost: null,
      qualityLimitationReason: null,
    });
  });

  it('is null without an outbound video stream', () => {
    expect(readVideoSendSample(report([{ id: 'oa', type: 'outbound-rtp', kind: 'audio' }]))).toBe(
      null
    );
  });
});

const sample = (o: Partial<VideoSendSample>): VideoSendSample => ({
  framesEncoded: 0,
  packetsSent: 0,
  packetsLost: 0,
  rtt: null,
  availableOutgoingBitrate: null,
  qualityLimitationReason: null,
  bytesSent: null,
  totalEncodeTime: null,
  frameWidth: null,
  frameHeight: null,
  framesPerSecond: null,
  timestamp: null,
  ...o,
});

describe('videoEvidence', () => {
  it('is the loss and the rate sent between two samples, and the latest RTT, estimate and limit', () => {
    const ev = videoEvidence(
      sample({
        framesEncoded: 10,
        packetsSent: 100,
        packetsLost: 2,
        bytesSent: 0,
        timestamp: 1000,
      }),
      sample({
        framesEncoded: 70,
        packetsSent: 300,
        packetsLost: 22,
        rtt: 0.1,
        availableOutgoingBitrate: 900_000,
        qualityLimitationReason: 'bandwidth',
        bytesSent: 250_000,
        timestamp: 3000,
      })
    );
    expect(ev).toEqual({
      loss: 0.1,
      rtt: 0.1,
      available: 900_000,
      limit: 'bandwidth',
      sentBitrate: 1_000_000,
    });
  });

  it('gives no sent rate without both byte counts and a forward timestamp', () => {
    const a = sample({ framesEncoded: 1, bytesSent: 0, timestamp: 1000 });
    const rate = (b: Partial<VideoSendSample>) =>
      videoEvidence(a, sample({ framesEncoded: 2, ...b }))?.sentBitrate;
    expect(rate({ bytesSent: 10, timestamp: 1000 })).toBe(null);
    expect(rate({ bytesSent: null, timestamp: 2000 })).toBe(null);
    expect(rate({ bytesSent: 10, timestamp: null })).toBe(null);
  });

  it('is no evidence without a baseline, or when nothing was encoded since', () => {
    expect(videoEvidence(null, sample({ framesEncoded: 5 }))).toBe(null);
    expect(videoEvidence(sample({ framesEncoded: 5 }), null)).toBe(null);
    expect(videoEvidence(sample({ framesEncoded: 5 }), sample({ framesEncoded: 5 }))).toBe(null);
    expect(videoEvidence(sample({ framesEncoded: null }), sample({ framesEncoded: 5 }))).toBe(null);
  });

  it('gives no loss over too few packets or without a peer report, and clamps it to [0, 1]', () => {
    const few = videoEvidence(
      sample({ framesEncoded: 1, packetsSent: 0 }),
      sample({ framesEncoded: 2, packetsSent: MIN_PACKETS_FOR_LOSS - 1, packetsLost: 5 })
    );
    expect(few?.loss).toBe(null);
    const noReport = videoEvidence(
      sample({ framesEncoded: 1, packetsLost: null }),
      sample({ framesEncoded: 2, packetsSent: 500, packetsLost: null })
    );
    expect(noReport?.loss).toBe(null);
    const backwards = videoEvidence(
      sample({ framesEncoded: 1, packetsSent: 0, packetsLost: 10 }),
      sample({ framesEncoded: 2, packetsSent: 100, packetsLost: 4 })
    );
    expect(backwards?.loss).toBe(0);
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
    ['cpu', { ...CLEAN, limit: 'cpu' }],
    ['bandwidth, estimate under the need', { ...CLEAN, limit: 'bandwidth', available: 1_000_000 }],
    ['bandwidth, no estimate', { ...CLEAN, limit: 'bandwidth', available: null }],
  ])('reads %s as bad, one rung down at least', (_, ev) => {
    const v = judgeVideoEvidence(0, ev as VideoEvidence);
    expect(v.verdict).toBe('bad');
    expect(v.target).toBeGreaterThanOrEqual(1);
  });

  it('never drops on a low estimate alone: a still scene sends little and estimates little', () => {
    expect(judgeVideoEvidence(0, { ...CLEAN, available: 200_000 }).verdict).toBe('steady');
  });

  it('does not drop when the encoder says bandwidth but the estimate carries the rung', () => {
    expect(
      judgeVideoEvidence(0, { ...CLEAN, limit: 'bandwidth', available: 2_000_000 }).verdict
    ).toBe('steady');
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
    ['unknown loss', { ...CLEAN, loss: null }],
    ['loss at the clean bound', { ...CLEAN, loss: 0.03 }],
    ['a round trip at the clean bound', { ...CLEAN, rtt: 0.35 }],
    ['an encoder limited by bandwidth', { ...CLEAN, limit: 'bandwidth' }],
    ['an encoder limited otherwise', { ...CLEAN, limit: 'other' }],
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
    // No room over what is sent: the link may be what limits it.
    expect(judgeVideoEvidence(1, { ...stale, sentBitrate: 2_500_000 }).verdict).toBe('steady');
    // Room, but not the rung above's need.
    expect(
      judgeVideoEvidence(1, { ...stale, available: 1_000_000, sentBitrate: 500_000 }).verdict
    ).toBe('steady');
  });

  it('climbs with an unknown RTT, or an unknown limit the estimate answers for', () => {
    expect(judgeVideoEvidence(1, { ...CLEAN, rtt: null }).verdict).toBe('good');
    expect(judgeVideoEvidence(1, { ...CLEAN, limit: null }).verdict).toBe('good');
    expect(judgeVideoEvidence(1, { ...CLEAN, available: null }).verdict).toBe('good');
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
    // The next climb needs the doubled count (after the settling sample).
    const again = run(state, [CLEAN, ...Array(UP_AFTER_GOOD * 2 - 1).fill(CLEAN)]);
    expect(again.changes).toHaveLength(0);
    expect(run(again.state, [CLEAN]).changes).toMatchObject([{ direction: 'up', to: 0 }]);
  });

  it('a drop long after a climb is the link changing, not a failed probe', () => {
    const evs = [
      ...Array(UP_AFTER_GOOD).fill(CLEAN),
      CLEAN, // settling
      ...Array(PROBE_WATCH).fill({ ...CLEAN }),
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

  it('says ONCE that the peer sends no loss figure', () => {
    const noLoss = { ...CLEAN, loss: null };
    let state = initialVideoQuality();
    const said: number[] = [];
    for (let i = 1; i <= NO_LOSS_REPORT_WARN_AFTER * 3; i++) {
      const step = stepVideoQuality(state, noLoss);
      state = step.state;
      if (step.noLossReport) said.push(i);
    }
    expect(said).toEqual([NO_LOSS_REPORT_WARN_AFTER]);
    expect(state.rung).toBe(CALL_VIDEO_START_RUNG);
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
      'video quality down 720p30 -> 480p30 after 2 bad samples (loss=12% rtt=100ms limit=none avail=5000kbps sent=?)'
    );
    const failed = run(initialVideoQuality(), [
      ...Array(UP_AFTER_GOOD).fill(CLEAN),
      CLEAN,
      { ...CLEAN, loss: 0.3 },
    ]).changes[1];
    expect(describeVideoQualityChange(failed)).toBe(
      `video quality down 720p30 -> 480p30 after a severe sample, the climb into 720p30 failed - the next one needs ${UP_AFTER_GOOD * 2} clean samples (loss=30% rtt=40ms limit=none avail=5000kbps sent=?)`
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
      })
    ).toBe('loss=? rtt=? limit=? avail=? sent=?');
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
