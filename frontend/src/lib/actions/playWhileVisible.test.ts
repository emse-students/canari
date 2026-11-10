// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isExpectedPlayInterruption, playWhileVisible } from './playWhileVisible';

describe('isExpectedPlayInterruption', () => {
  const base = { stillVisible: true, paused: false, sourceChanged: false };

  it('an AbortError after the video left the screen is the feed own decision', () => {
    expect(isExpectedPlayInterruption('AbortError', { ...base, stillVisible: false })).toBe(true);
  });

  it('an AbortError on a paused or re-sourced element is explained', () => {
    expect(isExpectedPlayInterruption('AbortError', { ...base, paused: true })).toBe(true);
    expect(isExpectedPlayInterruption('AbortError', { ...base, sourceChanged: true })).toBe(true);
  });

  it('an AbortError with no explaining fact stays a warning', () => {
    expect(isExpectedPlayInterruption('AbortError', base)).toBe(false);
  });

  it('a refusal is never an expected interruption', () => {
    expect(isExpectedPlayInterruption('NotAllowedError', { ...base, stillVisible: false })).toBe(
      false
    );
  });
});

describe('a play() aborted by scrolling past', () => {
  let callback: IntersectionObserverCallback;
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

  beforeEach(() => {
    warn.mockClear();
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(cb: IntersectionObserverCallback) {
          callback = cb;
        }
        observe() {}
        disconnect() {}
      }
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  function enter(video: HTMLVideoElement, isIntersecting: boolean) {
    callback([{ isIntersecting } as IntersectionObserverEntry], {} as IntersectionObserver);
    return video;
  }

  it('logs no warning when the video leaves while its play is pending', async () => {
    const video = document.createElement('video');
    let reject!: (e: unknown) => void;
    vi.spyOn(video, 'play').mockImplementation(
      () => new Promise<void>((_, r) => (reject = r)) as Promise<void>
    );
    const action = playWhileVisible(video);
    enter(video, true);
    enter(video, false);
    reject(new DOMException('interrupted', 'AbortError'));
    await Promise.resolve();
    await Promise.resolve();
    expect(warn).not.toHaveBeenCalled();
    (action as { destroy?: () => void }).destroy?.();
  });

  it('Jamais leaves a video come into view on its first frame; Toujours (the default) plays it', async () => {
    const { settings } = await import('$lib/stores/settingsStore.svelte');
    settings.setVideoAutoplay('never');
    const still = document.createElement('video');
    const stillPlay = vi.spyOn(still, 'play').mockResolvedValue(undefined);
    const stillAction = playWhileVisible(still);
    enter(still, true);
    expect(stillPlay).not.toHaveBeenCalled();
    (stillAction as { destroy?: () => void }).destroy?.();

    settings.setVideoAutoplay('always');
    const playing = document.createElement('video');
    const play = vi.spyOn(playing, 'play').mockResolvedValue(undefined);
    const action = playWhileVisible(playing);
    enter(playing, true);
    expect(play).toHaveBeenCalledTimes(1);
    (action as { destroy?: () => void }).destroy?.();
    settings.setVideoAutoplay('');
  });

  it('still warns on a refusal', async () => {
    const video = document.createElement('video');
    vi.spyOn(video, 'play').mockRejectedValue(new DOMException('no', 'NotAllowedError'));
    const action = playWhileVisible(video);
    enter(video, true);
    await Promise.resolve();
    await Promise.resolve();
    expect(warn).toHaveBeenCalledTimes(1);
    (action as { destroy?: () => void }).destroy?.();
  });
});
