import { describe, it, expect } from 'vitest';
import { planSpeakerRoute } from './callAudioRoute';

const out = (label: string, deviceId: string) => ({ kind: 'audiooutput', label, deviceId });

describe('planSpeakerRoute', () => {
  // iPhone 12, 2026-10-30: no output is ever labelled "earpiece", and the log said so twice a call.
  it('asks the default output for the earpiece when no device carries that label', () => {
    expect(planSpeakerRoute([], false, true)).toEqual({ kind: 'default' });
    expect(planSpeakerRoute([out('Speaker', 's')], false, true)).toEqual({ kind: 'default' });
  });

  it('has nothing to do for the earpiece on an engine without setSinkId', () => {
    expect(planSpeakerRoute([], false, false)).toEqual({ kind: 'already-default' });
  });

  it('routes to a labelled device when there is one, either way', () => {
    expect(planSpeakerRoute([out('iPhone Speaker', 's')], true, true)).toEqual({
      kind: 'device',
      deviceId: 's',
    });
    expect(planSpeakerRoute([out('Earpiece', 'e')], false, true)).toEqual({
      kind: 'device',
      deviceId: 'e',
    });
  });

  it('is unavailable only for the LOUDSPEAKER, which cannot be reached', () => {
    expect(planSpeakerRoute([], true, true)).toEqual({ kind: 'unavailable' });
    expect(planSpeakerRoute([out('Speaker', 's')], true, false)).toEqual({ kind: 'unavailable' });
  });

  it('ignores inputs and other kinds', () => {
    expect(
      planSpeakerRoute([{ kind: 'audioinput', label: 'Speaker mic', deviceId: 'm' }], true, true)
    ).toEqual({ kind: 'unavailable' });
  });
});
