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
