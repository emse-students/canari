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
import { fakeCamera, fakeDeps, LIVE_ID, KEY } from './liveBroadcast.test-helper';
import { fragment, initSegment, join } from './fmp4.test-helper';

const ended = () => new LiveRefusalError(410, 'LIVE_ENDED', 'ended', 'ended', null, null, null);
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
    expect(deps.startLive).toHaveBeenCalledWith(KEY, 'asso-1');
    expect(b.phase).toBe('live');
    expect(b.liveId).toBe(LIVE_ID);
    expect(recorders).toHaveLength(1);
    expect(recorders[0].stream).toBe(cam.session.stream);
    expect(deps.wakeLock.hold).toHaveBeenCalled();
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

  it('any other stopping refusal ends as failed, and the live is ended on the server too', async () => {
    const { b, deps, uploaders } = await ready();
    await b.start();
    uploaders[0].options.onStopped!(refused('LIVE_SEGMENT_CONFLICT'));
    expect(b.endCause).toBe('failed');
    expect(deps.endLive).toHaveBeenCalledWith(LIVE_ID);
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
