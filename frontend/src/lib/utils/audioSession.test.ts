// @vitest-environment happy-dom
/**
 * THE PAGE OWNS ITS AUDIO SESSION CATEGORY (iPhone report and owner's rule, 2026-11-04).
 *
 * Pinned: the decision table (a placed or answered call or a held microphone = play-and-record, an
 * unmuted media = playback, everything else - a ring coming in included - ambient); the
 * TRANSITIONS as the facts arrive from the call gate, the playback arbiter and the captures, one
 * set per change and none for an equal type; every capture holds the microphone BEFORE it asks
 * (WebKit refuses an audio capture under any other override) and releases it when its audio tracks
 * stop or end; and a WKWebView without `navigator.audioSession` said once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  armAudioSession,
  captureUserMedia,
  decideAudioSessionType,
  holdMicrophone,
  reportAudibleMedia,
  resetAudioSessionForTest,
} from './audioSession';
import { reportCallSoundPhase, resetCallSoundGateForTest } from './callSoundGate';

/** A fake `navigator.audioSession` recording every type set on it. */
function fakeSession() {
  const set: string[] = [];
  let type = 'auto';
  const session = {
    get type() {
      return type;
    },
    set type(next: string) {
      type = next;
      set.push(next);
    },
  };
  Object.defineProperty(navigator, 'audioSession', { configurable: true, value: session });
  return { set, current: () => type };
}

/** A stand-in for `MediaStreamTrack`, whose prototype `stop` the capture watch wraps. */
class FakeTrack extends EventTarget {
  constructor(public kind: 'audio' | 'video') {
    super();
  }
  stop() {}
}

beforeEach(() => {
  resetCallSoundGateForTest();
  resetAudioSessionForTest();
  vi.stubGlobal('MediaStreamTrack', FakeTrack);
});

afterEach(() => {
  Reflect.deleteProperty(navigator, 'audioSession');
  Reflect.deleteProperty(window, 'webkit');
  resetAudioSessionForTest();
  resetCallSoundGateForTest();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const none = { callPhase: 'none', microphoneHeld: false, audibleMediaPlaying: false } as const;

describe('decideAudioSessionType', () => {
  it('is ambient when idle, and for a ring coming in', () => {
    expect(decideAudioSessionType(none)).toBe('ambient');
    expect(decideAudioSessionType({ ...none, callPhase: 'incoming' })).toBe('ambient');
  });

  it('is playback while an unmuted media plays', () => {
    expect(decideAudioSessionType({ ...none, audibleMediaPlaying: true })).toBe('playback');
  });

  it('is play-and-record for a call placed or answered, or a held microphone, whatever plays', () => {
    for (const callPhase of ['calling', 'incall'] as const) {
      expect(decideAudioSessionType({ ...none, callPhase, audibleMediaPlaying: true })).toBe(
        'play-and-record'
      );
    }
    expect(
      decideAudioSessionType({ ...none, microphoneHeld: true, audibleMediaPlaying: true })
    ).toBe('play-and-record');
  });
});

describe('the transitions', () => {
  it('arming sets ambient before any sound', () => {
    const { set } = fakeSession();
    armAudioSession();
    expect(set).toEqual(['ambient']);
  });

  it('an unmuted media takes playback and gives it back when it stops', () => {
    const { set } = fakeSession();
    armAudioSession();
    reportAudibleMedia(true);
    reportAudibleMedia(true);
    reportAudibleMedia(false);
    expect(set).toEqual(['ambient', 'playback', 'ambient']);
  });

  it('a call placed holds play-and-record until it ends, then the idle category returns', () => {
    const { set } = fakeSession();
    armAudioSession();
    reportCallSoundPhase('svc', 'calling');
    reportCallSoundPhase('svc', 'incall');
    reportCallSoundPhase('svc', 'ended');
    expect(set).toEqual(['ambient', 'play-and-record', 'ambient']);
  });

  it('a ring coming in stays ambient; answering it opens play-and-record', () => {
    const { set } = fakeSession();
    armAudioSession();
    reportCallSoundPhase('svc', 'incoming');
    expect(set).toEqual(['ambient']);
    reportCallSoundPhase('svc', 'incall');
    reportCallSoundPhase('svc', 'idle');
    expect(set).toEqual(['ambient', 'play-and-record', 'ambient']);
  });

  it('after a call, an unmuted media still playing gets playback back', () => {
    const { set } = fakeSession();
    armAudioSession();
    reportAudibleMedia(true);
    reportCallSoundPhase('svc', 'calling');
    reportCallSoundPhase('svc', 'ended');
    expect(set).toEqual(['ambient', 'playback', 'play-and-record', 'playback']);
  });

  it('a refusal by the engine is said at error level and retried at the next change', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    Object.defineProperty(navigator, 'audioSession', {
      configurable: true,
      value: {
        set type(_next: string) {
          throw new DOMException('no page', 'InvalidStateError');
        },
      },
    });
    armAudioSession();
    expect(error).toHaveBeenCalledTimes(1);
    const { set } = fakeSession();
    reportAudibleMedia(true);
    expect(set).toEqual(['playback']);
  });
});

describe('the microphone', () => {
  /** `getUserMedia` answering one stream of `kinds`, recording the session type at the ask. */
  function devices(kinds: ('audio' | 'video')[], session: { current: () => string }) {
    const tracks = kinds.map((k) => new FakeTrack(k));
    const typeAtAsk: string[] = [];
    const getUserMedia = vi.fn(async () => {
      typeAtAsk.push(session.current());
      return {
        getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
        getTracks: () => tracks,
      } as unknown as MediaStream;
    });
    return { devices: { getUserMedia } as unknown as MediaDevices, tracks, typeAtAsk };
  }

  it('is held BEFORE the ask (play-and-record) and released when its tracks stop (ambient)', async () => {
    const session = fakeSession();
    armAudioSession();
    const d = devices(['audio'], session);
    const stream = await captureUserMedia(d.devices, { audio: true }, 'voice-note');
    expect(d.typeAtAsk).toEqual(['play-and-record']);
    expect(session.current()).toBe('play-and-record');
    stream.getAudioTracks()[0].stop();
    expect(session.current()).toBe('ambient');
  });

  it('an unmuted media starting or stopping during a recording does not move the type', async () => {
    const session = fakeSession();
    armAudioSession();
    const d = devices(['audio'], session);
    const stream = await captureUserMedia(d.devices, { audio: true }, 'voice-note');
    reportAudibleMedia(true);
    reportAudibleMedia(false);
    expect(session.current()).toBe('play-and-record');
    expect(session.set).toEqual(['ambient', 'play-and-record']);
    stream.getAudioTracks()[0].stop();
    expect(session.current()).toBe('ambient');
  });

  it('the camera path: held across video and audio, released only when every audio track ended', async () => {
    const session = fakeSession();
    armAudioSession();
    const d = devices(['video', 'audio', 'audio'], session);
    await captureUserMedia(d.devices, { video: true, audio: true }, 'reel-camera');
    expect(d.typeAtAsk).toEqual(['play-and-record']);
    // The video track and one of two audio tracks: still held.
    d.tracks[0].stop();
    d.tracks[1].dispatchEvent(new Event('ended'));
    expect(session.current()).toBe('play-and-record');
    // A track ended by the system, then stopped by the page: counted once.
    d.tracks[1].stop();
    expect(session.current()).toBe('play-and-record');
    d.tracks[2].stop();
    expect(session.current()).toBe('ambient');
  });

  it('a refused capture releases at once and rethrows', async () => {
    const session = fakeSession();
    armAudioSession();
    const refusal = new DOMException('no', 'NotAllowedError');
    const getUserMedia = vi.fn(async () => {
      throw refusal;
    });
    await expect(
      captureUserMedia({ getUserMedia } as unknown as MediaDevices, { audio: true }, 'call')
    ).rejects.toBe(refusal);
    expect(session.current()).toBe('ambient');
  });

  it('a capture without audio holds nothing', async () => {
    const session = fakeSession();
    armAudioSession();
    const d = devices(['video'], session);
    await captureUserMedia(d.devices, { video: true }, 'camera-switch');
    expect(d.typeAtAsk).toEqual(['ambient']);
    expect(session.set).toEqual(['ambient']);
  });

  it('two captures: the session waits for the last release', () => {
    const session = fakeSession();
    const a = holdMicrophone('a');
    const b = holdMicrophone('b');
    a('done');
    a('done again');
    expect(session.current()).toBe('play-and-record');
    b('done');
    expect(session.current()).toBe('ambient');
  });
});

describe('an engine without navigator.audioSession', () => {
  it('in a WKWebView, says once that the switch may be ignored', () => {
    Object.defineProperty(window, 'webkit', {
      configurable: true,
      value: { messageHandlers: {} },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    armAudioSession();
    reportAudibleMedia(true);
    reportAudibleMedia(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('navigator.audioSession is absent');
  });

  it('elsewhere, says nothing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    armAudioSession();
    reportAudibleMedia(true);
    expect(warn).not.toHaveBeenCalled();
  });
});
