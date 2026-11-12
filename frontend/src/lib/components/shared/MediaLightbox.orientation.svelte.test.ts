// @vitest-environment happy-dom
/**
 * THE LIGHTBOX TURNS FOR A VIDEO ONLY (owner, 2026-11-09; screen-orientation.md): `auto` is requested
 * while the item on show is a video, released when it becomes a photo and when the viewer closes.
 * The rotate button is drawn in the header only over a video, and only where the build can force.
 */
import { describe, it, expect, afterAll, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

const runtime = vi.hoisted(() => ({ android: true }));
vi.mock('$lib/utils/appVersion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/appVersion')>()),
  isAndroidTauriRuntime: () => runtime.android,
  isIosTauriRuntime: () => false,
}));

import Host from './MediaLightboxVideoHost.test-helper.svelte';
import { resetScreenOrientationForTest } from '$lib/mobile/screenOrientation.svelte';
import { videoSound } from '$lib/stores/videoSound.svelte';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';

afterAll(adoptTransitionAnimations());

type Win = Window & { canariOrientation?: { set: (m: string) => void } };
const mounted: (() => void)[] = [];
let sent: string[];

beforeEach(() => {
  resetScreenOrientationForTest();
  runtime.android = true;
  sent = [];
  (window as Win).canariOrientation = { set: (m) => sent.push(m) };
  videoSound.setMuted(true);
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  delete (window as Win).canariOrientation;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function open(slide: 'video-a' | 'video-b' | 'image', isOpen = true) {
  const props = $state({ slide, open: isOpen });
  const instance = mount(Host, { target: document.body, props });
  mounted.push(() => unmount(instance));
  flushSync();
  return props;
}

const rotateButton = () => document.querySelector('[data-rotate-button]');

describe('the lightbox requests rotation for a video only', () => {
  it('requests auto while a video is on show, with the rotate button', () => {
    open('video-a');
    expect(sent).toEqual(['auto']);
    expect(rotateButton()).not.toBeNull();
  });

  it('requests nothing for a photo, and draws no rotate button', () => {
    open('image');
    expect(sent).toEqual([]);
    expect(rotateButton()).toBeNull();
  });

  it('releases when the item becomes a photo and asks again for the next video', () => {
    const props = open('video-a');
    props.slide = 'image';
    flushSync();
    expect(sent).toEqual(['auto', 'portrait']);
    expect(rotateButton()).toBeNull();
    props.slide = 'video-b';
    flushSync();
    expect(sent).toEqual(['auto', 'portrait', 'auto']);
  });

  it('keeps one request across a swipe from a video to another video', () => {
    const props = open('video-a');
    props.slide = 'video-b';
    flushSync();
    expect(sent.filter((m) => m === 'portrait')).toEqual([]);
    expect(sent.at(-1)).toBe('auto');
  });

  it('releases when the viewer closes', () => {
    const props = open('video-a');
    props.open = false;
    flushSync();
    expect(sent).toEqual(['auto', 'portrait']);
  });

  it('forces landscape from the rotate button', () => {
    open('video-a');
    (rotateButton() as HTMLButtonElement).click();
    flushSync();
    expect(sent).toEqual(['auto', 'landscape']);
  });

  it('draws no rotate button where the build cannot force (the web)', () => {
    runtime.android = false;
    open('video-a');
    expect(rotateButton()).toBeNull();
  });
});
