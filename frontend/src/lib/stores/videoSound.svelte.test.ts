// @vitest-environment happy-dom
/**
 * THE VIDEO SOUND IS REMEMBERED PER DEVICE (owner, 2026-11-09), with the two rules kept from the
 * session-only store: the first ever run is silent, and a stored "on" is honoured at start only where
 * the engine allows an audible start without a gesture.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VIDEO_SOUND_KEY, initialVideoMuted } from './videoSound.svelte';

describe('initialVideoMuted', () => {
  it('a device that never chose starts muted, wherever it runs', () => {
    expect(initialVideoMuted(null, true)).toBe(true);
    expect(initialVideoMuted(null, false)).toBe(true);
  });

  it('a stored "off" starts muted', () => {
    expect(initialVideoMuted('off', true)).toBe(true);
  });

  it('a stored "on" starts audible only where the engine allows an audible start', () => {
    expect(initialVideoMuted('on', true)).toBe(false);
    expect(initialVideoMuted('on', false), 'a browser before any gesture').toBe(true);
  });
});

describe('the store', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  async function freshStore() {
    return (await import('./videoSound.svelte')).videoSound;
  }

  it('starts muted on a device that never chose, and writes nothing by itself', async () => {
    const store = await freshStore();
    expect(store.muted).toBe(true);
    expect(localStorage.getItem(VIDEO_SOUND_KEY)).toBeNull();
  });

  it("remembers the reader's choice for the next run", async () => {
    vi.stubGlobal('navigator', { ...navigator, userActivation: { hasBeenActive: true } });
    const store = await freshStore();
    store.toggle();
    expect(store.muted).toBe(false);
    expect(localStorage.getItem(VIDEO_SOUND_KEY)).toBe('on');

    vi.resetModules();
    expect((await freshStore()).muted, 'a cold start with the sound left on').toBe(false);

    (await freshStore()).setMuted(true);
    expect(localStorage.getItem(VIDEO_SOUND_KEY)).toBe('off');
  });

  /**
   * AN ENGINE'S REFUSAL IS NOT THE READER'S CHOICE: the live viewer, refused an audible start, plays
   * muted - silent for this session, the stored "on" kept, and a viewer's `volumechange` that follows
   * writes nothing.
   */
  it('a refused audible start silences this session and keeps the stored choice', async () => {
    vi.stubGlobal('navigator', { ...navigator, userActivation: { hasBeenActive: true } });
    const store = await freshStore();
    store.setMuted(false);
    vi.spyOn(console, 'info').mockImplementation(() => {});
    store.muteForRefusedStart();
    expect(store.muted).toBe(true);
    store.setMuted(true);
    expect(localStorage.getItem(VIDEO_SOUND_KEY), 'the follow-up volumechange').toBe('on');

    vi.resetModules();
    expect((await freshStore()).muted, 'the next run has the sound back').toBe(false);
  });

  it('a browser with no gesture yet starts muted and keeps the stored "on" for the next tap', async () => {
    localStorage.setItem(VIDEO_SOUND_KEY, 'on');
    vi.stubGlobal('navigator', { ...navigator, userActivation: { hasBeenActive: false } });
    const store = await freshStore();
    expect(store.muted).toBe(true);
    expect(localStorage.getItem(VIDEO_SOUND_KEY)).toBe('on');
  });

  it('an unreadable value is no choice', async () => {
    localStorage.setItem(VIDEO_SOUND_KEY, 'loud');
    vi.stubGlobal('navigator', { ...navigator, userActivation: { hasBeenActive: true } });
    expect((await freshStore()).muted).toBe(true);
  });
});

describe('the volume level (owner, 2026-11-11)', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
    vi.stubGlobal('navigator', { ...navigator, userActivation: { hasBeenActive: true } });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  async function fresh() {
    return await import('./videoSound.svelte');
  }

  it('starts at full on a device that never chose, and writes nothing by itself', async () => {
    const { videoSound, VIDEO_VOLUME_KEY } = await fresh();
    expect(videoSound.level).toBe(1);
    expect(localStorage.getItem(VIDEO_VOLUME_KEY)).toBeNull();
  });

  it('remembers the level across a reload', async () => {
    const first = await fresh();
    first.videoSound.setVolume(0.4);
    first.videoSound.commitLevel();
    vi.resetModules();
    const second = await fresh();
    expect(second.videoSound.level).toBe(0.4);
    expect(second.videoSound.muted).toBe(false);
  });

  it('dragging to 0 is mute and keeps the last non-zero level; dragging up unmutes', async () => {
    const { videoSound } = await fresh();
    videoSound.setVolume(0.6);
    videoSound.setVolume(0);
    expect(videoSound.muted).toBe(true);
    expect(videoSound.level).toBe(0.6);
    videoSound.toggle();
    expect(videoSound.muted, 'the speaker unmutes').toBe(false);
    expect(videoSound.level, 'restoring the last non-zero level').toBe(0.6);
    videoSound.setVolume(0);
    videoSound.setVolume(0.2);
    expect(videoSound.muted).toBe(false);
    expect(videoSound.level).toBe(0.2);
  });

  it('writes the level once per gesture, never per tick', async () => {
    const { videoSound, VIDEO_VOLUME_KEY } = await fresh();
    for (const v of [0.9, 0.8, 0.7, 0.6]) videoSound.setVolume(v);
    expect(localStorage.getItem(VIDEO_VOLUME_KEY), 'nothing per tick').toBeNull();
    videoSound.commitLevel();
    expect(localStorage.getItem(VIDEO_VOLUME_KEY)).toBe('0.6');
    localStorage.removeItem(VIDEO_VOLUME_KEY);
    videoSound.commitLevel();
    expect(localStorage.getItem(VIDEO_VOLUME_KEY), 'a second commit writes nothing').toBeNull();
  });

  it('clamps, and ignores a stored value that is not a usable level', async () => {
    localStorage.setItem('canari-video-volume', 'loud');
    const { videoSound } = await fresh();
    expect(videoSound.level).toBe(1);
    videoSound.setLevel(7);
    expect(videoSound.level).toBe(1);
  });

  it('survives a storage that throws', async () => {
    const { videoSound } = await fresh();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => {
      videoSound.setVolume(0.3);
      videoSound.commitLevel();
    }).not.toThrow();
    expect(videoSound.level).toBe(0.3);
  });
});
