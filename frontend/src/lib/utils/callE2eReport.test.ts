import { describe, expect, it } from 'vitest';
import {
  describeE2eReport,
  diagnoseE2eReport,
  e2eBypassedSides,
  engineFromUserAgent,
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
