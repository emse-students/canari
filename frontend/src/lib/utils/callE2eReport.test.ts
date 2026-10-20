import { describe, expect, it } from 'vitest';
import {
  describeE2eReport,
  describeVideoFrames,
  diagnoseE2eReport,
  e2eBypassedSides,
  engineFromUserAgent,
  inconclusiveMedia,
  rtpPacketCounts,
  transformAttribute,
  type E2eEngineFacts,
  type E2eWorkerReport,
} from './callE2eReport';

const NATIVE: E2eEngineFacts = {
  engine: 'Chrome/152',
  senderAttr: 'native',
  receiverAttr: 'native',
};

function report(over: Partial<E2eWorkerReport> = {}): E2eWorkerReport {
  return {
    tag: '5 s after connected',
    transformers: { sender: 1, receiver: 1 },
    framesIn: { sender: 250, receiver: 251 },
    encrypted: { audio: 250, video: 0 },
    decrypted: { audio: 249, video: 0 },
    decryptFailures: 0,
    tooShort: 2,
    tooShortEmpty: 2,
    droppedNoKey: 0,
    opusInvalid: { sender: 0, receiver: 0 },
    doubleEncrypted: 0,
    ...over,
  };
}

describe('transformAttribute', () => {
  it('is native for an accessor anywhere on the chain', () => {
    class Base {
      get transform() {
        return null;
      }
    }
    class Sender extends Base {}
    expect(transformAttribute(Sender.prototype)).toBe('native');
  });

  it('is absent on an engine without it, or with a plain data property', () => {
    expect(transformAttribute({})).toBe('absent');
    expect(transformAttribute({ transform: null })).toBe('absent');
    expect(transformAttribute(undefined)).toBe('absent');
  });
});

describe('engineFromUserAgent', () => {
  it('keeps the engine and its major version only', () => {
    expect(
      engineFromUserAgent(
        'Mozilla/5.0 (Linux; Android 16; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/152.0.7977.82 Mobile Safari/537.36'
      )
    ).toBe('Chrome/152');
    expect(
      engineFromUserAgent(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'
      )
    ).toBe('iOS/27');
    expect(
      engineFromUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Safari/605.1.15'
      )
    ).toBe('Safari/26');
    expect(engineFromUserAgent('curl/8')).toBe('?');
  });
});

describe('diagnoseE2eReport / describeE2eReport', () => {
  it('a transform plainly in the path is not an ERROR, and the line carries every count', () => {
    expect(diagnoseE2eReport(report(), NATIVE)).toBeNull();
    const line = describeE2eReport(report(), NATIVE);
    expect(line).toBe(
      '[Call] E2E worker report (5 s after connected): transformers sender=1 receiver=1 | frames in sender=250 receiver=251 | encrypted audio=250 video=0 | decrypted audio=249 video=0 | decrypt-failed=0 short=2 (empty 2) no-key=0 not-opus sender=0 receiver=0 double=0 | engine=Chrome/152 attr sender=native receiver=native'
    );
  });

  it('names each way the media can miss the worker', () => {
    const cases: Array<[Partial<E2eWorkerReport>, E2eEngineFacts, string]> = [
      [
        { framesIn: { sender: 9 } },
        { ...NATIVE, senderAttr: 'absent' },
        'may flow around the worker',
      ],
      [{ transformers: { sender: 1 } }, NATIVE, 'never handed the worker a transformer'],
      [{ framesIn: {} }, NATIVE, 'no frame reached either transform'],
      [{ framesIn: { receiver: 9 } }, NATIVE, 'no frame reached the SENDER transform'],
      [{ framesIn: { sender: 9 } }, NATIVE, 'no frame reached the RECEIVER transform'],
      [{ opusInvalid: { sender: 0, receiver: 4 } }, NATIVE, 'non-Opus audio crossed'],
    ];
    for (const [over, facts, says] of cases) {
      const line = describeE2eReport(report(over), facts);
      expect(line.startsWith('[Call] ERROR E2E worker report')).toBe(true);
      expect(line).toContain(says);
    }
  });

  it('a missing attribute with BOTH transforms fed is a note, never an ERROR', () => {
    const facts: E2eEngineFacts = { ...NATIVE, receiverAttr: 'absent' };
    expect(diagnoseE2eReport(report(), facts)).toEqual({
      level: 'note',
      text: 'this engine has no native transform attribute, yet both transforms were fed',
    });
    expect(describeE2eReport(report(), facts).startsWith('[Call] E2E worker report')).toBe(true);
  });

  it('a side with no frame is not judged when judgeFrames is false (a call ended before 5 s)', () => {
    const short = report({ framesIn: { sender: 40 } });
    expect(diagnoseE2eReport(short, NATIVE, false)).toBeNull();
    expect(describeE2eReport(short, NATIVE, false)).not.toContain('ERROR');
    // A real fault is still one.
    expect(
      diagnoseE2eReport(report({ doubleEncrypted: 1, framesIn: {} }), NATIVE, false)?.level
    ).toBe('fault');
  });
});

describe('a report after a rebuilt peer connection (review L3)', () => {
  // The dead peer connection 1 fed 900 frames; the rebuilt 2 fed its sender and not its receiver.
  const rebuilt = report({
    framesIn: { sender: 1150, receiver: 900 },
    framesInBy: { '1|sender|audio': 900, '1|receiver|audio': 900, '2|sender|audio': 250 },
  });

  it('judges and prints the frames of the epoch it is asked about, never the lifetime sums', () => {
    expect(diagnoseE2eReport(rebuilt, NATIVE, true)).toBeNull();
    expect(diagnoseE2eReport(rebuilt, NATIVE, true, 2)?.level).toBe('fault');
    expect(describeE2eReport(rebuilt, NATIVE, true, 2)).toContain(
      'frames in sender=250 receiver=0 (peer connection 2)'
    );
  });
});

describe('inconclusiveMedia (review S1)', () => {
  const packets = (sa: number, ra: number, sv = 0, rv = 0) => ({
    sent: { audio: sa, video: sv },
    received: { audio: ra, video: rv },
  });
  const t = (
    kind: string,
    currentDirection: RTCRtpTransceiverDirection | null,
    hasTrack = true,
    stopped = false
  ) => ({ kind, currentDirection, hasTrack, stopped });

  it('is conclusive when every negotiated direction carried packets', () => {
    expect(inconclusiveMedia([t('audio', 'sendrecv')], packets(250, 251))).toEqual([]);
  });

  it('names a camera whose m-line is not negotiated yet, and a negotiated kind with no packet', () => {
    expect(
      inconclusiveMedia([t('audio', 'sendrecv'), t('video', null)], packets(250, 251))
    ).toEqual(['video m-line not negotiated yet']);
    expect(inconclusiveMedia([t('video', 'sendrecv')], packets(0, 0, 0, 30))).toEqual([
      'sender:video carried no packet yet',
    ]);
    expect(inconclusiveMedia([t('video', 'recvonly', false)], packets(0, 0))).toEqual([
      'receiver:video carried no packet yet',
    ]);
  });

  it('ignores what sends nothing of ours: a bare sender, a stopped transceiver, an unknown kind', () => {
    expect(
      inconclusiveMedia(
        [t('video', null, false), t('video', 'sendrecv', true, true), t('', 'sendrecv')],
        packets(0, 0)
      )
    ).toEqual([]);
    // A bare sender on a negotiated direction still receives: only its receiver is judged.
    expect(inconclusiveMedia([t('video', 'sendrecv', false)], packets(0, 0, 0, 40))).toEqual([]);
  });
});

describe('e2eBypassedSides (CALL-E2E-BYPASS-MI9T)', () => {
  const packets = (sa: number, ra: number, sv = 0, rv = 0) => ({
    sent: { audio: sa, video: sv },
    received: { audio: ra, video: rv },
  });
  const by = (m: Record<string, number>) => report({ framesInBy: m });

  it('names each side and kind whose packets crossed the network while no transform saw a frame', () => {
    // The Mi 9T's reading of 2026-10-20: transformers 1/1, frames 0/0, media flowing both ways.
    expect(e2eBypassedSides(by({}), packets(250, 248), 1)).toEqual([
      'sender:audio',
      'receiver:audio',
    ]);
    // A camera added mid-call on a short-circuited sender, while the audio goes through.
    expect(
      e2eBypassedSides(
        by({ '1|sender|audio': 250, '1|receiver|audio': 240, '1|receiver|video': 90 }),
        packets(250, 240, 120, 90),
        1
      )
    ).toEqual(['sender:video']);
  });

  it('judges only the peer connection it is asked about: the frames of a dead one prove nothing', () => {
    const old = by({ '1|sender|audio': 900, '1|receiver|audio': 900 });
    expect(e2eBypassedSides(old, packets(250, 240), 2)).toEqual(['sender:audio', 'receiver:audio']);
  });

  it('accuses nothing when every flowing kind went through the worker, or nothing flowed', () => {
    const fed = by({ '1|sender|audio': 250, '1|receiver|audio': 251 });
    expect(e2eBypassedSides(fed, packets(250, 251), 1)).toEqual([]);
    expect(e2eBypassedSides(by({}), packets(0, 0), 1)).toEqual([]);
  });

  it('sums the packets of every outbound and inbound RTP stream, per kind', () => {
    const stats = new Map<string, unknown>([
      ['o1', { type: 'outbound-rtp', kind: 'audio', packetsSent: 200 }],
      ['o2', { type: 'outbound-rtp', kind: 'video', packetsSent: 50 }],
      ['i1', { type: 'inbound-rtp', kind: 'audio', packetsReceived: 240 }],
      ['c', { type: 'codec' }],
    ]) as unknown as RTCStatsReport;
    expect(rtpPacketCounts(stats)).toEqual(packets(200, 240, 50, 0));
  });
});

describe('the video segment of the report (lot 2)', () => {
  it('leaves an audio-only call line unchanged', () => {
    expect(describeVideoFrames(report())).toBe('');
    expect(describeE2eReport(report(), NATIVE)).not.toContain('video frames');
  });

  it('counts the video frames per side on this peer connection, with failures and key frames', () => {
    const r = report({
      framesInBy: { '3|sender|video': 900, '3|receiver|video': 880, '3|sender|audio': 250 },
      encrypted: { audio: 250, video: 900 },
      decrypted: { audio: 249, video: 879 },
      decryptFailuresBy: { audio: 0, video: 1 },
      videoKeyframesIn: 3,
      videoCodecUnexpected: 0,
    });
    expect(describeVideoFrames(r, 3)).toBe(
      'video frames in sender=900 receiver=880 encrypted=900 decrypted=879 decrypt-failed=1 keyframes-in=3 not-vp8=0 | '
    );
  });

  it('is a FAULT when a frame of another codec crossed the transform', () => {
    const d = diagnoseE2eReport(report({ videoCodecUnexpected: 4 }), NATIVE);
    expect(d?.level).toBe('fault');
    expect(describeE2eReport(report({ videoCodecUnexpected: 4 }), NATIVE)).toMatch(
      /^\[Call\] ERROR .*not-vp8=4/
    );
  });
});
