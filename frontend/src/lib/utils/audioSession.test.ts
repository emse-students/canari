// @vitest-environment happy-dom
/**
 * THE PAGE OWNS ITS AUDIO SESSION CATEGORY (iPhone report and owner's rule, 2026-11-04).
 *
 * Pinned: the decision table (a placed or answered call = play-and-record, an unmuted media =
 * playback, everything else - a ring coming in included - ambient); the TRANSITIONS as the facts
 * arrive from the call gate and the playback arbiter, one set per change and none for an equal
 * type; and an iPhone without `navigator.audioSession` said once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => ({ ios: false }));
vi.mock('$lib/utils/appVersion', () => ({ isIosTauriRuntime: () => platform.ios }));

import {
  armAudioSession,
  decideAudioSessionType,
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
  return set;
}

beforeEach(() => {
  resetCallSoundGateForTest();
  resetAudioSessionForTest();
  platform.ios = false;
});

afterEach(() => {
  Reflect.deleteProperty(navigator, 'audioSession');
  resetAudioSessionForTest();
  resetCallSoundGateForTest();
  vi.restoreAllMocks();
});

describe('decideAudioSessionType', () => {
  it('is ambient when idle, and for a ring coming in', () => {
    expect(decideAudioSessionType({ callPhase: 'none', audibleMediaPlaying: false })).toBe(
      'ambient'
    );
    expect(decideAudioSessionType({ callPhase: 'incoming', audibleMediaPlaying: false })).toBe(
      'ambient'
    );
  });

  it('is playback while an unmuted media plays', () => {
    expect(decideAudioSessionType({ callPhase: 'none', audibleMediaPlaying: true })).toBe(
      'playback'
    );
  });

  it('is play-and-record for a call placed or answered, whatever else plays', () => {
    for (const callPhase of ['calling', 'incall'] as const) {
      expect(decideAudioSessionType({ callPhase, audibleMediaPlaying: true })).toBe(
        'play-and-record'
      );
    }
  });
});

describe('the transitions', () => {
  it('arming sets ambient before any sound', () => {
    const set = fakeSession();
    armAudioSession();
    expect(set).toEqual(['ambient']);
  });

  it('an unmuted media takes playback and gives it back when it stops', () => {
    const set = fakeSession();
    armAudioSession();
    reportAudibleMedia(true);
    reportAudibleMedia(true);
    reportAudibleMedia(false);
    expect(set).toEqual(['ambient', 'playback', 'ambient']);
  });

  it('a call placed holds play-and-record until it ends, then the idle category returns', () => {
    const set = fakeSession();
    armAudioSession();
    reportCallSoundPhase('svc', 'calling');
    reportCallSoundPhase('svc', 'incall');
    reportCallSoundPhase('svc', 'ended');
    expect(set).toEqual(['ambient', 'play-and-record', 'ambient']);
  });

  it('a ring coming in stays ambient; answering it opens play-and-record', () => {
    const set = fakeSession();
    armAudioSession();
    reportCallSoundPhase('svc', 'incoming');
    expect(set).toEqual(['ambient']);
    reportCallSoundPhase('svc', 'incall');
    reportCallSoundPhase('svc', 'idle');
    expect(set).toEqual(['ambient', 'play-and-record', 'ambient']);
  });

  it('after a call, an unmuted media still playing gets playback back', () => {
    const set = fakeSession();
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
    const set = fakeSession();
    reportAudibleMedia(true);
    expect(set).toEqual(['playback']);
  });
});

describe('an engine without navigator.audioSession', () => {
  it('on an iPhone, says once that the switch may be ignored', () => {
    platform.ios = true;
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
