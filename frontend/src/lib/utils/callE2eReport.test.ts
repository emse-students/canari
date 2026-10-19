import { describe, expect, it } from 'vitest';
import {
  describeE2eReport,
  diagnoseE2eReport,
  engineFromUserAgent,
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
