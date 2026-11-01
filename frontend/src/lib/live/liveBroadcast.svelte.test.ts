/**
 * THE BROADCASTER'S STATE MACHINE with a fake camera, recorder, uploader and server: preview ->
 * live -> (reconnecting) -> away -> live again on the SAME live -> ended, by every road the brief
 * names - the End button, a 410 from the uploader, a return after the window, a lens taken, and the
 * screen leaving. No real clock, no real sleep.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveRefusalError } from './api';
import { LiveBroadcast, startProblemOf } from './liveBroadcast.svelte';
import { TransportFailureError } from '$lib/utils/transportFailure';
import { fakeCamera, fakeDeps, LIMITS, LIVE_ID, KEY } from './liveBroadcast.test-helper';
import { CameraAccessError } from '$lib/reels/cameraAccess';
import { fragment, initSegment, join, readTimes } from './fmp4.test-helper';
import {
  LIVE_BACKLOG_MARGIN_SEGMENTS,
  LIVE_RECORDER_STOP_BOUND_MS,
  LIVE_SEGMENT_MS,
} from './constants';

const ended = () => new LiveRefusalError(410, 'LIVE_ENDED', 'ended', 'ended', null, null, null);
const cut = () =>
  new LiveRefusalError(410, 'LIVE_ENDED', 'ended', 'ended', null, null, null, 'cut');
const refused = (code: string) =>
  new LiveRefusalError(409, code, code, 'refused', null, null, null);

async function settle() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

/** A broadcast in preview with the camera open and the limits read. */
async function ready(associationId: string | null = null) {
  const f = fakeDeps();
  const cam = fakeCamera();
  const b = new LiveBroadcast(cam.session, associationId, f.deps);
  await cam.session.start();
  await b.loadLimits();
  return { ...f, cam, b };
}

/** One recorder chunk through the real pipeline, and the queue it reached. */
async function chunk(r: { onChunk: (c: Blob) => void }, bytes: Uint8Array) {
  r.onChunk(new Blob([bytes as Uint8Array<ArrayBuffer>]));
  await vi.waitFor(() => undefined);
  await settle();
}

beforeEach(() => {
  for (const level of ['debug', 'log', 'warn'] as const) {
    vi.spyOn(console, level).mockImplementation(() => {});
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('LiveBroadcast - preview and start', () => {
  it('Start waits for the camera AND the server limits, and is refused on an engine that cannot record', async () => {
    const f = fakeDeps();
    const cam = fakeCamera();
    const b = new LiveBroadcast(cam.session, null, f.deps);
    expect(b.canStart).toBe(false);
    await cam.session.start();
    expect(b.canStart).toBe(false);
    await b.loadLimits();
    expect(b.canStart).toBe(true);

    const g = fakeDeps();
    g.deps.recordingSupported.mockReturnValue(false);
    const c2 = fakeCamera();
    const b2 = new LiveBroadcast(c2.session, null, g.deps);
    await c2.session.start();
    await b2.loadLimits();
    await b2.start();
    expect(b2.startProblem).toBe('unsupported');
    expect(g.deps.startLive).not.toHaveBeenCalled();
  });

  it('limits: a bare gateway 404 is the switch, no answer is offline', async () => {
    const f = fakeDeps();
    f.deps.fetchLiveLimits.mockRejectedValueOnce(
      new LiveRefusalError(404, null, 'off', 'disabled', null, null, null)
    );
    const b = new LiveBroadcast(fakeCamera().session, null, f.deps);
    await b.loadLimits();
    expect(b.limitsProblem).toBe('disabled');
    f.deps.fetchLiveLimits.mockRejectedValueOnce(new TransportFailureError(new TypeError('x')));
    await b.loadLimits();
    expect(b.limitsProblem).toBe('offline');
  });

  it('goes on air: the generated key and the association reach the server, a recorder runs on the open camera, the screen is held', async () => {
    const { b, deps, recorders, cam } = await ready('asso-1');
    await b.start();
    expect(deps.startLive).toHaveBeenCalledWith(KEY, 'asso-1', undefined);
    expect(b.phase).toBe('live');
    expect(b.liveId).toBe(LIVE_ID);
    expect(recorders).toHaveLength(1);
    expect(recorders[0].stream).toBe(cam.session.stream);
    expect(deps.wakeLock.hold).toHaveBeenCalled();
  });

  it('a suspension keeps its end date, a withdrawal has its own reason', async () => {
    const { b, deps } = await ready();
    deps.startLive.mockRejectedValueOnce(
      new LiveRefusalError(
        403,
        'LIVE_BROADCAST_SUSPENDED',
        '',
        'suspended',
        null,
        null,
        null,
        null,
        '2026-11-20T10:00:00.000Z'
      )
    );
    await b.start();
    expect(b.startProblem).toBe('suspended');
    expect(b.startSuspendedUntil).toBe('2026-11-20T10:00:00.000Z');
    expect(
      startProblemOf(
        new LiveRefusalError(403, 'LIVE_BROADCAST_WITHDRAWN', '', 'withdrawn', null, null, null)
      )
    ).toBe('withdrawn');
  });

  it('a refused start returns to the preview with its reason, read from the code', async () => {
    const { b, deps } = await ready();
    deps.startLive.mockRejectedValueOnce(refused('LIVE_ALREADY_OPEN'));
    await b.start();
    expect(b.phase).toBe('preview');
    expect(b.startProblem).toBe('already-open');
    expect(startProblemOf(refused('LIVE_MUTED'))).toBe('muted');
    expect(
      startProblemOf(
        new LiveRefusalError(403, 'LIVE_ASSOCIATION_FORBIDDEN', '', 'refused', null, null, null)
      )
    ).toBe('association-forbidden');
    expect(
      startProblemOf(
        new LiveRefusalError(429, 'LIVE_START_RATE', '', 'rate-limited', null, null, null)
      )
    ).toBe('rate-limited');
    expect(startProblemOf(new TransportFailureError(new TypeError('x')))).toBe('offline');
  });
});

describe('LiveBroadcast - the first-live rules (L11)', () => {
  const NEVER = { version: 1, acceptedVersion: null, acceptedAt: null };
  const rulesRefusal = () =>
    new LiveRefusalError(403, 'LIVE_RULES_NOT_ACCEPTED', '', 'refused', null, null, null);

  it('never accepted: Start waits for "I accept", and the start then carries the version', async () => {
    const f = fakeDeps();
    f.deps.fetchLiveRules.mockResolvedValue(NEVER);
    const cam = fakeCamera();
    const b = new LiveBroadcast(cam.session, null, f.deps);
    await cam.session.start();
    await b.loadLimits();
    expect(b.rulesPending).toBe(true);
    expect(b.canStart).toBe(false);
    b.acceptRules();
    expect(b.rulesPending).toBe(false);
    expect(b.canStart).toBe(true);
    await b.start();
    expect(f.deps.startLive).toHaveBeenCalledWith(KEY, undefined, 1);
    expect(b.phase).toBe('live');
  });

  it('accepted at this version before: no rules step, and the start carries no version', async () => {
    const { b, deps } = await ready();
    expect(b.rulesPending).toBe(false);
    await b.start();
    expect(deps.startLive).toHaveBeenCalledWith(KEY, undefined, undefined);
  });

  it('the rules changed since (accepted v1, now v2): shown again', async () => {
    const f = fakeDeps();
    f.deps.fetchLiveRules.mockResolvedValue({ version: 2, acceptedVersion: 1, acceptedAt: 'x' });
    const b = new LiveBroadcast(fakeCamera().session, null, f.deps);
    await b.loadLimits();
    expect(b.rulesPending).toBe(true);
  });

  it('LIVE_RULES_NOT_ACCEPTED: the rules are read again and shown, with their own sentence', async () => {
    const { b, deps } = await ready();
    deps.startLive.mockRejectedValueOnce(rulesRefusal());
    deps.fetchLiveRules.mockResolvedValueOnce({ version: 2, acceptedVersion: 1, acceptedAt: 'x' });
    await b.start();
    expect(b.phase).toBe('preview');
    expect(b.startProblem).toBe('rules-not-accepted');
    expect(deps.fetchLiveRules).toHaveBeenCalledTimes(2);
    expect(b.rulesPending).toBe(true);
    b.acceptRules();
    expect(b.startProblem).toBeNull();
    await b.start();
    expect(deps.startLive).toHaveBeenLastCalledWith(KEY, undefined, 2);
  });

  it('LIVE_RULES_NOT_ACCEPTED with the re-read failing: the limits Retry, Start waits', async () => {
    const { b, deps } = await ready();
    deps.startLive.mockRejectedValueOnce(rulesRefusal());
    deps.fetchLiveRules.mockRejectedValueOnce(new TransportFailureError(new TypeError('x')));
    await b.start();
    expect(b.limitsProblem).toBe('offline');
    expect(b.rules).toBeNull();
    expect(b.canStart).toBe(false);
  });

  it('a rules read that fails is the limits problem, and Start waits', async () => {
    const f = fakeDeps();
    f.deps.fetchLiveRules.mockRejectedValueOnce(new TransportFailureError(new TypeError('x')));
    const cam = fakeCamera();
    const b = new LiveBroadcast(cam.session, null, f.deps);
    await cam.session.start();
    await b.loadLimits();
    expect(b.limitsProblem).toBe('offline');
    expect(b.canStart).toBe(false);
  });

  it('LIVE_MUTED is its own sentence, and records nothing about the rules', async () => {
    const { b, deps } = await ready();
    deps.startLive.mockRejectedValueOnce(
      new LiveRefusalError(403, 'LIVE_MUTED', '', 'refused', null, null, null)
    );
    await b.start();
    expect(b.startProblem).toBe('muted');
    expect(deps.fetchLiveRules).toHaveBeenCalledTimes(1);
  });
});

describe('LiveBroadcast - on air', () => {
  it("a chunk is sealed for the live and queued at the uploader's next index", async () => {
    const { b, deps, recorders, uploaders } = await ready();
    await b.start();
    await chunk(recorders[0], join(initSegment(), fragment()));
    expect(uploaders[0].sent.map((s) => s.index)).toEqual([0]);
    expect(deps.seal).toHaveBeenCalledWith(KEY, LIVE_ID, 0, expect.any(Uint8Array));
  });

  it('a retried send shows "reconnecting" with the backlog, a stored one clears it', async () => {
    const { b, uploaders } = await ready();
    await b.start();
    const u = uploaders[0];
    u.backlog = 3;
    u.options.onRetry!(0, 1, new TransportFailureError(new TypeError('x')));
    expect(b.health).toBe('retrying');
    expect(b.backlog).toBe(3);
    u.backlog = 0;
    u.options.onStored!({ index: 0, name: 'n', nextIndex: 1 });
    expect(b.health).toBe('ok');
    expect(b.backlog).toBe(0);
  });

  it("a 410 from the uploader ends the screen with the server's cause, and asks no end of a live already ended", async () => {
    const { b, deps, uploaders, recorders, cam } = await ready();
    await b.start();
    uploaders[0].options.onStopped!(ended());
    expect(b.phase).toBe('ended');
    expect(b.endCause).toBe('server');
    expect(deps.endLive).not.toHaveBeenCalled();
    expect(recorders[0].stop).toHaveBeenCalled();
    expect(cam.control.opened[0].video.stop).toHaveBeenCalled();
    expect(deps.wakeLock.release).toHaveBeenCalled();
  });

  it('a 410 whose endReason is cut ends the screen as a moderation cut, with no end asked', async () => {
    const { b, deps, uploaders } = await ready();
    await b.start();
    uploaders[0].options.onStopped!(cut());
    expect(b.phase).toBe('ended');
    expect(b.endCause).toBe('cut');
    expect(deps.endLive).not.toHaveBeenCalled();
  });

  it("a cut heard while the End drains is the moderators', not the member's", async () => {
    const { b, uploaders } = await ready();
    await b.start();
    let drain!: () => void;
    uploaders[0].idle.mockImplementation(() => new Promise<void>((r) => (drain = r)));
    const ending = b.end();
    await vi.waitFor(() => expect(uploaders[0].idle).toHaveBeenCalled());
    uploaders[0].options.onStopped!(cut());
    drain();
    await ending;
    expect(b.endCause).toBe('cut');
  });

  it('any other stopping refusal ends as failed, and the live is ended on the server too', async () => {
    const { b, deps, uploaders } = await ready();
    await b.start();
    uploaders[0].options.onStopped!(refused('LIVE_SEGMENT_CONFLICT'));
    expect(b.endCause).toBe('failed');
    expect(deps.endLive).toHaveBeenCalledWith(LIVE_ID);
  });

  it("the chat's end verdict ends the screen exactly as the uploader's would; anything else is ignored", async () => {
    const { b, deps } = await ready();
    await b.start();
    b.chatHeardEnd(refused('LIVE_SEGMENT_CONFLICT'));
    expect(b.phase).toBe('live');
    b.chatHeardEnd(ended());
    expect(b.phase).toBe('ended');
    expect(b.endCause).toBe('server');
    expect(deps.endLive).not.toHaveBeenCalled();
    // A second report after the end changes nothing.
    b.chatHeardEnd(ended());
    expect(b.endCause).toBe('server');
  });

  it("the chat's 410 with endReason 'cut' ends the screen as a cut", async () => {
    const { b } = await ready();
    await b.start();
    b.chatHeardEnd(new LiveRefusalError(410, 'LIVE_ENDED', '', 'ended', null, null, null, 'cut'));
    expect(b.phase).toBe('ended');
    expect(b.endCause).toBe('cut');
  });

  it('the chat reads the key the live was started with', async () => {
    const { b } = await ready();
    expect(b.chatKey).toBeNull();
    await b.start();
    expect(b.chatKey).toBe(KEY);
  });

  it('End: the recorder stops, the last chunk is queued, the queue drains, THEN the live is ended', async () => {
    const { b, deps, recorders, uploaders } = await ready();
    await b.start();
    await chunk(recorders[0], initSegment());
    const order: string[] = [];
    recorders[0].stop.mockImplementation(async () => {
      order.push('recorder stopped');
      recorders[0].onChunk(new Blob([fragment() as Uint8Array<ArrayBuffer>]));
    });
    uploaders[0].idle.mockImplementation(async () => {
      order.push(`idle with ${uploaders[0].sent.length} sent`);
    });
    deps.endLive.mockImplementation(async () => {
      order.push('end');
      return { id: LIVE_ID, endedAt: 'x', endReason: 'broadcaster' as const };
    });
    await b.end();
    expect(order).toEqual(['recorder stopped', 'idle with 1 sent', 'end']);
    expect(b.phase).toBe('ended');
    expect(b.endCause).toBe('broadcaster');
  });

  it('End offline: the camera and the screen lock are given back BEFORE the queue drains, and the drain is bounded by the reconnect window', async () => {
    const { b, deps, uploaders, cam, fireTimers } = await ready();
    await b.start();
    uploaders[0].idle.mockImplementation(() => new Promise(() => {})); // offline: never drains
    const ending = b.end();
    await vi.waitFor(() => expect(cam.control.opened[0].video.stop).toHaveBeenCalled());
    expect(b.phase).toBe('ending');
    expect(deps.wakeLock.release).toHaveBeenCalled();
    expect(uploaders[0].stop).not.toHaveBeenCalled();
    fireTimers(LIMITS.reconnectWindowMs);
    await ending;
    expect(uploaders[0].stop).toHaveBeenCalled(); // the unsent queue is dropped
    expect(deps.endLive).toHaveBeenCalledWith(LIVE_ID);
    expect(b.phase).toBe('ended');
  });

  it('End with a recorder that never answers its stop: the wait is bounded, then the live ends', async () => {
    const { b, deps, recorders, fireTimers } = await ready();
    await b.start();
    recorders[0].stop.mockImplementation(() => new Promise(() => {}));
    const ending = b.end();
    await settle();
    expect(deps.endLive).not.toHaveBeenCalled();
    fireTimers(LIVE_RECORDER_STOP_BOUND_MS);
    await ending;
    expect(deps.endLive).toHaveBeenCalledTimes(1);
    expect(b.phase).toBe('ended');
  });

  it('leaving while the end waits for the network ends the live once, and the wait does nothing after', async () => {
    const { b, deps, uploaders, fireTimers } = await ready();
    await b.start();
    uploaders[0].idle.mockImplementation(() => new Promise(() => {}));
    const ending = b.end();
    await vi.waitFor(() => expect(deps.sleep).toHaveBeenCalledWith(LIMITS.reconnectWindowMs));
    b.dispose();
    expect(uploaders[0].stop).toHaveBeenCalled();
    fireTimers(LIMITS.reconnectWindowMs);
    await ending;
    expect(deps.endLive).toHaveBeenCalledTimes(1);
  });

  it('nothing stored for longer than the reconnect window ends the live as a lost connection, dropping the queue', async () => {
    const { b, deps, uploaders, recorders, clock } = await ready();
    await b.start();
    const u = uploaders[0];
    u.backlog = 10;
    clock.t += LIMITS.reconnectWindowMs;
    u.options.onRetry!(0, 9, new TransportFailureError(new TypeError('x')));
    expect(b.phase).toBe('live'); // exactly the window: the server still holds the live
    clock.t += 1;
    u.options.onRetry!(0, 10, new TransportFailureError(new TypeError('x')));
    expect(b.phase).toBe('ended');
    expect(b.endCause).toBe('connection-lost');
    expect(u.stop).toHaveBeenCalled();
    expect(recorders[0].stop).toHaveBeenCalled();
    expect(deps.endLive).toHaveBeenCalledWith(LIVE_ID);
  });

  it('an absence longer than the window is not silence on air: the return keeps the live, and a new silence ON AIR still ends it', async () => {
    const { b, uploaders, recorders, clock, setHidden } = await ready();
    await b.start();
    const u = uploaders[0];
    setHidden(true);
    b.appHidden();
    expect(b.phase).toBe('away');
    clock.t += LIMITS.reconnectWindowMs * 3;
    setHidden(false);
    b.appVisible();
    await vi.waitFor(() => expect(b.phase).toBe('live'));
    expect(recorders).toHaveLength(2);
    u.backlog = 1;
    u.options.onRetry!(0, 1, new TransportFailureError(new TypeError('x')));
    expect(b.phase).toBe('live');
    clock.t += LIMITS.reconnectWindowMs + 1;
    u.options.onRetry!(0, 2, new TransportFailureError(new TypeError('x')));
    expect(b.phase).toBe('ended');
    expect(b.endCause).toBe('connection-lost');
  });

  it('a slow but ALIVE uplink (80 % of real time) is never called a lost connection: past the cap it ends as too slow', async () => {
    const { b, uploaders, clock } = await ready();
    await b.start();
    const cap =
      Math.ceil(LIMITS.reconnectWindowMs / LIVE_SEGMENT_MS) + LIVE_BACKLOG_MARGIN_SEGMENTS;
    const u = uploaders[0];
    // Every 2 s one segment is recorded; the server stores 4 in every 5 - the backlog grows by one
    // every 5 segments, and a segment is STORED at least every 2.5 s throughout.
    let stored = 0;
    for (let s = 1; b.phase === 'live' && s < 10_000; s++) {
      clock.t += LIVE_SEGMENT_MS;
      if (s % 5 !== 0) {
        u.options.onStored!({ index: stored, name: 'n', nextIndex: stored + 1 });
        stored++;
      }
      u.backlog = s - stored;
      u.options.onRetry!(stored, 1, new TransportFailureError(new TypeError('slow')));
    }
    expect(b.phase).toBe('ended');
    expect(b.endCause).toBe('upload-too-slow');
    expect(b.backlog).toBe(cap + 1);
  });

  it("a 410 heard while the End drains labels the end as the server's, not the member's", async () => {
    const { b, uploaders } = await ready();
    await b.start();
    let drain!: () => void;
    uploaders[0].idle.mockImplementation(() => new Promise<void>((r) => (drain = r)));
    const ending = b.end();
    await vi.waitFor(() => expect(uploaders[0].idle).toHaveBeenCalled());
    uploaders[0].options.onStopped!(ended());
    drain();
    await ending;
    expect(b.phase).toBe('ended');
    expect(b.endCause).toBe('server');
  });

  it('a recorder whose fragments can never be sent (every one over the size limit) goes away with a reason, not a silent ON AIR', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { b, recorders, uploaders } = await ready();
    b.limits = { ...LIMITS, segmentMaxBytes: initSegment().length + 4 + 200 };
    await b.start();
    await chunk(recorders[0], initSegment());
    for (let i = 0; i < 5 && b.phase === 'live'; i++) {
      await chunk(recorders[0], fragment({ mediaBytes: 500 }));
    }
    await vi.waitFor(() => expect(b.phase).toBe('away'));
    expect(b.awayProblem).toBe('unsendable');
    expect(uploaders[0].sent).toEqual([]);
    await b.reacquire();
    expect(b.phase).toBe('live');
    expect(b.awayProblem).toBeNull();
  });

  it('a chunk the pipeline cannot read takes the screen off air (away, camera given back) instead of a silent ON AIR', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { b, recorders, cam } = await ready();
    await b.start();
    recorders[0].onChunk({ arrayBuffer: () => Promise.reject(new Error('NotReadable')) } as Blob);
    await vi.waitFor(() => expect(b.phase).toBe('away'));
    expect(recorders[0].stop).toHaveBeenCalled();
    expect(cam.control.opened[0].video.stop).toHaveBeenCalled();
    await b.reacquire();
    expect(b.phase).toBe('live');
    expect(recorders).toHaveLength(2);
  });

  it('iOS mutes a lens and unmutes it: nothing is re-recorded', async () => {
    const { b, recorders, cam } = await ready();
    await b.start();
    const lens = cam.control.opened[0].video;
    lens.dispatchEvent(new Event('mute'));
    lens.dispatchEvent(new Event('unmute'));
    await settle();
    expect(b.phase).toBe('live');
    expect(recorders).toHaveLength(1);
  });
});

describe('LiveBroadcast - background and return', () => {
  it('hidden: the recorder stops and the camera is given back; back: the SAME live on a new recorder, indexes continuing, media time shifted', async () => {
    const { b, deps, recorders, uploaders, cam, clock, setHidden } = await ready();
    await b.start();
    await chunk(recorders[0], join(initSegment(), fragment()));

    clock.t += 20_000;
    setHidden(true);
    b.appHidden();
    expect(b.phase).toBe('away');
    expect(recorders[0].stop).toHaveBeenCalled();
    expect(cam.control.opened[0].video.stop).toHaveBeenCalled();
    expect(deps.wakeLock.release).toHaveBeenCalled();

    setHidden(false);
    b.appVisible();
    await vi.waitFor(() => expect(b.phase).toBe('live'));
    expect(deps.fetchLive).toHaveBeenCalledWith(LIVE_ID);
    expect(deps.startLive).toHaveBeenCalledTimes(1);
    expect(recorders).toHaveLength(2);
    expect(recorders[1].stream).toBe(cam.control.opened[1].stream);

    await chunk(recorders[1], join(initSegment(), fragment({ videoTime: 0n })));
    expect(uploaders[0].sent.map((s) => s.index)).toEqual([0, 1]);
  });

  it("the return waits for the OLD recorder's last chunk, which goes out with the old init and no shift", async () => {
    const { b, recorders, uploaders, clock, setHidden } = await ready();
    await b.start();
    await chunk(recorders[0], join(initSegment(), fragment({ videoTime: 0n })));
    let stopped!: () => void;
    recorders[0].stop.mockImplementation(() => new Promise<void>((r) => (stopped = r)));
    clock.t += 20_000;
    setHidden(true);
    b.appHidden();
    setHidden(false);
    b.appVisible();
    await settle();
    await settle();
    expect(recorders).toHaveLength(1); // no new recorder while the old one hands over
    recorders[0].onChunk(new Blob([fragment({ videoTime: 180_000n }) as Uint8Array<ArrayBuffer>]));
    stopped();
    await vi.waitFor(() => expect(b.phase).toBe('live'));
    expect(recorders).toHaveLength(2);
    const second = uploaders[0].sent[1].sealed.slice(4 + initSegment().length);
    expect(readTimes(second).video).toBe(180_000n);
  });

  it('a return after the server ended it (410 on the read) is the end screen, and no camera is reopened', async () => {
    const { b, deps, recorders, cam, setHidden } = await ready();
    await b.start();
    setHidden(true);
    b.appHidden();
    deps.fetchLive.mockRejectedValueOnce(ended());
    setHidden(false);
    b.appVisible();
    await vi.waitFor(() => expect(b.phase).toBe('ended'));
    expect(b.endCause).toBe('server-while-away');
    expect(cam.control.opened).toHaveLength(1);
    expect(recorders).toHaveLength(1);
  });

  it("a return with no answer from the server re-acquires anyway: the uploader's verdict decides", async () => {
    const { b, deps, recorders, setHidden } = await ready();
    await b.start();
    setHidden(true);
    b.appHidden();
    deps.fetchLive.mockRejectedValueOnce(new TransportFailureError(new TypeError('x')));
    setHidden(false);
    b.appVisible();
    await vi.waitFor(() => expect(b.phase).toBe('live'));
    expect(recorders).toHaveLength(2);
  });

  it('hidden again while the return is re-acquiring: the stale re-acquisition records nothing', async () => {
    const { b, recorders, setHidden } = await ready();
    await b.start();
    setHidden(true);
    b.appHidden();
    setHidden(false);
    b.appVisible();
    setHidden(true);
    b.appHidden();
    await settle();
    await settle();
    expect(b.phase).toBe('away');
    expect(recorders).toHaveLength(1);
  });

  it('a lens taken while visible: away with a Retry, which re-acquires on the same live', async () => {
    const { b, recorders, cam } = await ready();
    await b.start();
    cam.control.opened[0].video.end();
    expect(b.phase).toBe('away');
    expect(recorders[0].stop).toHaveBeenCalled();
    await b.reacquire();
    expect(b.phase).toBe('live');
    expect(recorders).toHaveLength(2);
  });

  it('a refused camera on return stays away, with the live kept for a Retry', async () => {
    const { b, cam, recorders, setHidden } = await ready();
    await b.start();
    setHidden(true);
    b.appHidden();
    const { CameraAccessError } = await import('$lib/reels/cameraAccess');
    cam.control.nextFailure = new CameraAccessError('busy', 'busy');
    setHidden(false);
    b.appVisible();
    await vi.waitFor(() => expect(cam.session.phase).toBe('error'));
    expect(b.phase).toBe('away');
    expect(recorders).toHaveLength(1);
  });

  it('a recorder that fails on air goes away rather than ending the live', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { b, recorders } = await ready();
    await b.start();
    recorders[0].onError(new Event('error'));
    expect(b.phase).toBe('away');
  });
});

describe('LiveBroadcast - leaving the screen', () => {
  it('dispose on air stops everything and ends the live best-effort', async () => {
    const { b, deps, uploaders, cam } = await ready();
    await b.start();
    b.dispose();
    expect(uploaders[0].stop).toHaveBeenCalled();
    expect(cam.control.opened[0].video.stop).toHaveBeenCalled();
    expect(deps.endLive).toHaveBeenCalledWith(LIVE_ID);
  });

  it('dispose while the start is in flight: the live the server opens anyway is ended', async () => {
    const { b, deps } = await ready();
    let answer!: (
      v: ReturnType<typeof deps.startLive> extends Promise<infer T> ? T : never
    ) => void;
    deps.startLive.mockImplementationOnce(() => new Promise((r) => (answer = r)));
    const started = b.start();
    await vi.waitFor(() => expect(deps.startLive).toHaveBeenCalled());
    b.dispose();
    const { liveView } = await import('./liveBroadcast.test-helper');
    answer(liveView());
    await started;
    expect(deps.endLive).toHaveBeenCalledWith(LIVE_ID);
    expect(deps.createUploader).not.toHaveBeenCalled();
  });

  it('dispose in the preview ends nothing on the server', async () => {
    const { b, deps } = await ready();
    b.dispose();
    expect(deps.endLive).not.toHaveBeenCalled();
  });
});

describe('LiveBroadcast - the screen as the source (owner, 2026-10-31)', () => {
  /** A preview where the browser can share a screen and the camera is open. */
  async function desktop() {
    const f = fakeDeps();
    f.deps.screenShareAvailable.mockReturnValue(true);
    const cam = fakeCamera();
    const b = new LiveBroadcast(cam.session, null, f.deps);
    await cam.session.start();
    await b.loadLimits();
    return { ...f, cam, b };
  }

  it('offers the screen only where the browser can share one', async () => {
    const phone = await ready();
    expect(phone.b.canShareScreen).toBe(false);
    await phone.b.chooseSource('screen');
    expect(phone.b.source).toBe('camera');
    expect(phone.deps.openScreen).not.toHaveBeenCalled();
    expect(await desktop().then((d) => d.b.canShareScreen)).toBe(true);
  });

  it('choosing the screen opens it instead of the camera, and the camera comes back on request', async () => {
    const { b, cam, deps } = await desktop();
    expect(cam.control.opened).toHaveLength(1);
    await b.chooseSource('screen');
    expect(b.source).toBe('screen');
    expect(deps.openScreen).toHaveBeenCalledTimes(1);
    expect(cam.session.phase).toBe('live');
    await b.chooseSource('camera');
    expect(b.source).toBe('camera');
    expect(cam.control.opened).toHaveLength(2);
    expect(deps.openScreen).toHaveBeenCalledTimes(1);
  });

  it('a dismissed picker returns to the camera at once, on the camera and not on a fault', async () => {
    const { b, cam, deps } = await desktop();
    deps.openScreen.mockRejectedValueOnce(new CameraAccessError('denied', 'dismissed'));
    await b.chooseSource('screen');
    expect(b.source).toBe('camera');
    expect(cam.session.phase).toBe('live');
    expect(cam.session.fault).toBeNull();
    expect(cam.control.opened).toHaveLength(2);
  });

  it('the source cannot change once the live started', async () => {
    const { b, deps } = await desktop();
    await b.start();
    await b.chooseSource('screen');
    expect(b.source).toBe('camera');
    expect(deps.openScreen).not.toHaveBeenCalled();
  });

  it('a share stopped WHILE THE LIVE IS STARTING ends it the moment the start lands', async () => {
    const { b, deps, cam } = await desktop();
    await b.chooseSource('screen');
    const real = deps.startLive.getMockImplementation()!;
    let land: () => void = () => {};
    deps.startLive.mockImplementationOnce(
      (...args: Parameters<typeof real>) =>
        new Promise((resolve) => {
          land = () => resolve(real(...args));
        })
    );
    const starting = b.start();
    await vi.waitFor(() => expect(b.phase).toBe('starting'));
    await b.screenShareStopped();
    expect(deps.endLive).not.toHaveBeenCalled();
    land();
    await starting;
    await vi.waitFor(() => expect(b.phase).toBe('ended'));
    expect(deps.endLive).toHaveBeenCalledTimes(1);
    expect(cam.session.phase).not.toBe('starting');
  });

  it('a stop remembered during a start that FAILS does not end the next start', async () => {
    const { b, deps } = await desktop();
    await b.chooseSource('screen');
    const real = deps.startLive.getMockImplementation()!;
    let fail: (e: unknown) => void = () => {};
    deps.startLive.mockImplementationOnce(() => new Promise((_resolve, reject) => (fail = reject)));
    const first = b.start();
    await vi.waitFor(() => expect(b.phase).toBe('starting'));
    await b.screenShareStopped();
    fail(new Error('network'));
    await first;
    expect(b.phase).toBe('preview');
    deps.startLive.mockImplementation(real);
    await b.start();
    expect(b.phase).toBe('live');
    expect(deps.endLive).not.toHaveBeenCalled();
  });

  it('makes the mixing context synchronously inside the choice, before any await', async () => {
    const { b, deps } = await desktop();
    let sync = false;
    deps.createAudioContext.mockImplementation(() => {
      sync = true;
      return null;
    });
    const choosing = b.chooseSource('screen');
    expect(sync).toBe(true);
    await choosing;
    expect(deps.openScreen).toHaveBeenCalledWith(null);
  });

  it('the source choice is locked while the picker is open', async () => {
    const { b, deps } = await desktop();
    let answer: (s: MediaStream) => void = () => {};
    deps.openScreen.mockImplementationOnce(() => new Promise<MediaStream>((r) => (answer = r)));
    const choosing = b.chooseSource('screen');
    await vi.waitFor(() => expect(b.choosingSource).toBe(true));
    await b.chooseSource('camera');
    expect(b.source).toBe('screen');
    answer({
      getTracks: () => [],
      getVideoTracks: () => [],
      getAudioTracks: () => [],
    } as unknown as MediaStream);
    await choosing;
    expect(b.choosingSource).toBe(false);
  });

  it('a hidden page does not pause a screen share, and does pause a camera', async () => {
    const screen = await desktop();
    await screen.b.chooseSource('screen');
    await screen.b.start();
    screen.setHidden(true);
    screen.b.appHidden();
    expect(screen.b.phase).toBe('live');
    expect(screen.cam.session.phase).toBe('live');

    const camera = await desktop();
    await camera.b.start();
    camera.setHidden(true);
    camera.b.appHidden();
    expect(camera.b.phase).toBe('away');
  });

  it('a share stopped from the browser ends the live cleanly, once, and a camera never does', async () => {
    const { b, deps, cam } = await desktop();
    await b.chooseSource('screen');
    await b.start();
    await b.screenShareStopped();
    expect(b.phase).toBe('ended');
    expect(b.endCause).toBe('broadcaster');
    expect(deps.endLive).toHaveBeenCalledTimes(1);
    await b.screenShareStopped();
    expect(deps.endLive).toHaveBeenCalledTimes(1);
    expect(cam.session.phase).not.toBe('starting');

    const camera = await desktop();
    await camera.b.start();
    await camera.b.screenShareStopped();
    expect(camera.b.phase).toBe('live');
  });
});
