import { describe, expect, test } from 'bun:test';
import {
  compareDigests,
  failureOf,
  frameCount,
  provenOf,
  sizeSummary,
  VIDEO_ABSENT_AFTER_AUDIO_MULTIPLE,
} from './lib.mjs';

const opts = { frames: 10, videoFrames: 5, video: true };

describe('frameCount', () => {
  test('a positive whole count is taken', () => {
    expect(frameCount('frames', '250')).toBe(250);
  });
  test.each(['0', '-3', 'abc', '2.5', '', undefined])('%p is refused', (raw) => {
    expect(() => frameCount('frames', raw)).toThrow('--frames must be a whole number of frames');
  });
});

/** A pair of page states in which every proof holds. */
function proven() {
  return {
    pub: {
      fault: null,
      connectionState: 'connected',
      report: { encrypted: { audio: 12, video: 6 }, transformErrors: 0, droppedNoKey: 0 },
      outbound: { audio: { packetsSent: 12 }, video: { packetsSent: 30 } },
    },
    sub: {
      fault: null,
      connectionState: 'connected',
      report: {
        decrypted: { audio: 11, video: 6 },
        decryptFailures: 0,
        framesIn: { receiver: 17 },
        videoKeyframesIn: 1,
        transformErrors: 0,
        droppedNoKey: 0,
      },
      inbound: { audio: { packetsReceived: 11 }, video: { packetsReceived: 25 } },
    },
  };
}

describe('compareDigests', () => {
  test('every received frame was sent: byte-identical', () => {
    const r = compareDigests(['3:aa', '4:bb', '5:cc'], ['4:bb', '3:aa']);
    expect(r.byteIdentical).toBe(true);
    expect(r.matched).toBe(2);
    expect(r.unmatched).toBe(0);
    expect(r.receivedSizes).toEqual({ count: 2, min: 3, median: 4, max: 4 });
  });

  test('one altered frame is named and breaks identity', () => {
    const r = compareDigests(['3:aa'], ['3:aa', '3:ab']);
    expect(r.byteIdentical).toBe(false);
    expect(r.unmatched).toBe(1);
    expect(r.unmatchedSamples).toEqual(['3:ab']);
  });

  test('nothing received proves nothing', () => {
    expect(compareDigests(['3:aa'], []).byteIdentical).toBe(false);
  });
});

test('sizeSummary of nothing is all null', () => {
  expect(sizeSummary([])).toEqual({ count: 0, min: null, median: null, max: null });
});

describe('the verdict', () => {
  test('a full proof passes and names no failure', () => {
    const { pub, sub } = proven();
    expect(failureOf(pub, sub, opts)).toBeNull();
    expect(provenOf(pub, sub, opts)).toBe(true);
  });

  test('one decrypt failure fails, whatever else holds', () => {
    const { pub, sub } = proven();
    sub.report.decryptFailures = 1;
    sub.report.decryptFailuresBy = { audio: 0, video: 1 };
    expect(failureOf(pub, sub, opts)).toContain('failed to decrypt');
  });

  test('packets with no frame handed to the receiver transform is a bypass', () => {
    const { pub, sub } = proven();
    sub.report.framesIn = {};
    sub.report.decrypted = { audio: 0, video: 0 };
    expect(failureOf(pub, sub, opts)).toContain('bypassed');
  });

  test('packets with frames handed but none opened is a transform out of the path', () => {
    const { pub, sub } = proven();
    sub.report.decrypted = { audio: 0, video: 6 };
    expect(failureOf(pub, sub, opts)).toContain('0 audio frames decrypted');
  });

  test('audio far past its proof with no video packet: the SFU did not forward video', () => {
    const { pub, sub } = proven();
    sub.inbound = {
      audio: { packetsReceived: opts.frames * VIDEO_ABSENT_AFTER_AUDIO_MULTIPLE },
      video: { packetsReceived: 0 },
    };
    expect(failureOf(pub, sub, opts)).toContain('did not forward the video');
    expect(failureOf(pub, sub, { ...opts, video: false })).toBeNull();
  });

  test('a video with no key frame is not proven', () => {
    const { pub, sub } = proven();
    sub.report.videoKeyframesIn = 0;
    expect(provenOf(pub, sub, opts)).toBe(false);
    expect(provenOf(pub, sub, { ...opts, video: false })).toBe(true);
  });

  test('a failed peer connection or a page fault is named', () => {
    const a = proven();
    a.pub.connectionState = 'failed';
    expect(failureOf(a.pub, a.sub, opts)).toContain('publisher');
    const b = proven();
    b.sub.fault = 'worker died';
    expect(failureOf(b.pub, b.sub, opts)).toBe('subscriber: worker died');
  });
});
