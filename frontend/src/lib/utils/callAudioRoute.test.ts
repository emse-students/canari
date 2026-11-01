import { describe, it, expect } from 'vitest';
import { createSpeakerRouter, planSpeakerRoute } from './callAudioRoute';

const out = (label: string, deviceId: string) => ({ kind: 'audiooutput', label, deviceId });

describe('createSpeakerRouter ordering', () => {
  /** An enumerate() each test settles by hand, one call at a time. */
  function harness() {
    const pending: Array<() => void> = [];
    const logs: string[] = [];
    const devices = [out('Speaker', 's')];
    const route = createSpeakerRouter({
      enumerate: () => new Promise((resolve) => pending.push(() => resolve(devices))),
      log: (l) => logs.push(l),
    });
    const sink = () => {
      const calls: string[] = [];
      return { calls, setSinkId: async (id: string) => void calls.push(id) };
    };
    return { pending, logs, route, sink };
  }

  // A fast speaker on -> off must end on the earpiece: the stale request is dropped, not applied late.
  it('drops a request overtaken while it enumerated (speaker then earpiece)', async () => {
    const h = harness();
    const sink = h.sink();
    const first = h.route(sink, true);
    const second = h.route(sink, false);
    h.pending[1]();
    await second;
    h.pending[0]();
    await first;
    expect(sink.calls).toEqual(['']);
  });

  it('drops the older one when it settles first too', async () => {
    const h = harness();
    const sink = h.sink();
    const first = h.route(sink, true);
    const second = h.route(sink, false);
    h.pending[0]();
    await first;
    h.pending[1]();
    await second;
    expect(sink.calls).toEqual(['']);
  });

  it('keeps the voice and the ringback independent', async () => {
    const h = harness();
    const voice = h.sink();
    const ringback = h.sink();
    const a = h.route(voice, true);
    const b = h.route(ringback, true);
    h.pending[0]();
    h.pending[1]();
    await Promise.all([a, b]);
    expect(voice.calls).toEqual(['s']);
    expect(ringback.calls).toEqual(['s']);
  });

  it('says nothing for the earpiece without setSinkId, and WARNs for a missing loudspeaker', async () => {
    const h = harness();
    const none = {};
    const a = h.route(none, false);
    h.pending[0]();
    await a;
    expect(h.logs).toEqual([]);
    const b = h.route(none, true);
    h.pending[1]();
    await b;
    expect(h.logs.join('\n')).toContain("WARN no 'speaker' output");
  });
});

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
