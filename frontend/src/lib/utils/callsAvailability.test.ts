import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * A call entry point is shown only when BOTH locks are open: the build's switch (what this binary
 * can do) and the server's kill switch (what the estate allows now, B12).
 */
async function load(build: { calls: boolean; video: boolean }) {
  vi.resetModules();
  vi.doMock('$lib/features', () => ({
    CALLS_ENABLED: build.calls,
    CALLS_VIDEO_ENABLED: build.video,
  }));
  return import('./callsAvailability');
}

afterEach(() => {
  vi.doUnmock('$lib/features');
});

// THE FIRST IMPORT IS PAID HERE, NOT INSIDE A TEST'S 5 s BUDGET. `callsAvailability` pulls the
// app-version store and its graph; transforming that took 1.8 s on a quiet machine, inside the
// first test (measured 2026-10-30), and the transform queue is what a loaded machine stretches.
// Collection has no test deadline, and the later `load()` calls re-evaluate the cached transforms
// (~45 ms each).
await load({ calls: true, video: true });
vi.doUnmock('$lib/features');

describe('callsAvailable', () => {
  it('needs the server open, whatever the build carries', async () => {
    const a = await load({ calls: true, video: true });
    expect(a.callsAvailable('off')).toBe(false);
    expect(a.callsAvailable('audio')).toBe(true);
    expect(a.callsAvailable('audio_video')).toBe(true);
  });

  it('needs the build to carry calls, whatever the server allows', async () => {
    const a = await load({ calls: false, video: false });
    expect(a.callsAvailable('audio_video')).toBe(false);
  });
});

describe('callVideoAvailable', () => {
  it('needs audio_video from the server: audio-only hides the video button', async () => {
    const a = await load({ calls: true, video: true });
    expect(a.callVideoAvailable('off')).toBe(false);
    expect(a.callVideoAvailable('audio')).toBe(false);
    expect(a.callVideoAvailable('audio_video')).toBe(true);
  });

  it('needs the build to carry video: an audio-only binary never shows it', async () => {
    const a = await load({ calls: true, video: false });
    expect(a.callVideoAvailable('audio_video')).toBe(false);
  });
});
