/**
 * A VIDEO PLAYS WHERE IT IS, AND ONE ANSWER SAYS WHETHER EVERY VIDEO MAKES SOUND (user, 2026-09-29).
 *
 * Pinned: a video starts muted; its sound button changes the answer for EVERY video, the viewer's
 * included, and a change made in the viewer's own controls comes back to the feed; a video plays
 * while it is on screen and pauses when it leaves; a tap outside the sound button opens the viewer.
 */
import { it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import InlineVideo from './InlineVideo.svelte';
import { videoSound } from '$lib/stores/videoSound.svelte';
import { followVideoSound } from '$lib/actions/playWhileVisible';
import { TRANSPARENT_VIDEO_POSTER } from '$lib/utils/videoPoster';

const mounted: (() => void)[] = [];
let observed: ((entries: { isIntersecting: boolean }[]) => void)[] = [];

beforeEach(() => {
  observed = [];
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(cb: (entries: { isIntersecting: boolean }[]) => void) {
        observed.push(cb);
      }
      observe() {}
      disconnect() {}
    }
  );
  videoSound.setMuted(true);
});

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

function mountVideo() {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const onOpen = vi.fn();
  const component = mount(InlineVideo, {
    target,
    props: { src: 'blob:clip', onOpen, openLabel: 'Plein ecran' },
  });
  mounted.push(() => unmount(component));
  flushSync();
  const video = target.querySelector('video')!;
  const [openButton, soundButton] = Array.from(target.querySelectorAll('button'));
  return { video, openButton, soundButton, onOpen };
}

it('starts muted, and its sound button answers for every video', () => {
  const first = mountVideo();
  const second = mountVideo();
  expect(first.video.muted).toBe(true);
  // Without it the Android WebView draws its own grey play button until the first frame.
  expect(first.video.getAttribute('poster')).toBe(TRANSPARENT_VIDEO_POSTER);

  first.soundButton.click();
  flushSync();

  expect(videoSound.muted).toBe(false);
  expect(second.video.muted).toBe(false);
  expect(first.soundButton.getAttribute('aria-pressed')).toBe('true');
});

it("wears the theme's amber whatever the frame under it, and its colour says the state", () => {
  const { soundButton } = mountVideo();
  // Muted: an amber glyph on a scrim with no blur - a translucent blurred disc took the frame's hue.
  expect(soundButton.className).toContain('text-cn-yellow');
  expect(soundButton.className).not.toContain('backdrop-blur');

  soundButton.click();
  flushSync();

  expect(soundButton.className).toContain('bg-cn-yellow');
  expect(soundButton.className).toContain('text-cn-ink');
});

it('seeks a decrypted file to its first frame, and hands a stream its URL untouched', () => {
  const file = mountVideo();
  expect(file.video.getAttribute('src')).toBe('blob:clip#t=0.1');

  // An MSE URL with a fragment is a URL no MediaSource answers to: Chromium refuses it with
  // MEDIA_ERR_SRC_NOT_SUPPORTED before `sourceopen` (measured on the Mi 9T, 2026-10-01).
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(InlineVideo, {
    target,
    props: { src: 'blob:stream', onOpen: vi.fn(), openLabel: 'Plein ecran', streamed: true },
  });
  mounted.push(() => unmount(component));
  flushSync();
  expect(target.querySelector('video')!.getAttribute('src')).toBe('blob:stream');
});

it('loops, muted and inline, like a feed video (Instagram)', () => {
  const { video } = mountVideo();
  expect(video.loop).toBe(true);
  expect(video.muted).toBe(true);
  expect(video.hasAttribute('playsinline')).toBe(true);
});

it("covers the box with Canari's poster until the first frame, never the engine's", () => {
  const { video, openButton } = mountVideo();
  const poster = () => document.querySelector('[aria-hidden="true"].bg-linear-to-br');
  expect(video.hasAttribute('controls')).toBe(false);
  expect(poster()).not.toBeNull();
  // Decorative and click-through: the tap still reaches the button that opens the viewer.
  expect(poster()!.className).toContain('pointer-events-none');
  expect(openButton).toBeDefined();

  video.dispatchEvent(new Event('loadeddata'));
  flushSync();
  expect(poster()).toBeNull();
});

it('plays while it is on screen and pauses when it leaves', () => {
  const { video } = mountVideo();
  const play = vi.spyOn(video, 'play').mockResolvedValue();
  const pause = vi.spyOn(video, 'pause').mockImplementation(() => {});
  Object.defineProperty(video, 'paused', { configurable: true, get: () => false });

  observed.at(-1)!([{ isIntersecting: true }]);
  observed.at(-1)!([{ isIntersecting: false }]);

  expect(play).toHaveBeenCalledOnce();
  expect(pause).toHaveBeenCalledOnce();
});

it('opens the viewer on a tap outside the sound button, and not on it', () => {
  const { openButton, soundButton, onOpen } = mountVideo();
  soundButton.click();
  expect(onOpen).not.toHaveBeenCalled();
  openButton.click();
  expect(onOpen).toHaveBeenCalledOnce();
});

it("makes the viewer's own controls give the answer for every video", () => {
  const viewer = document.createElement('video');
  const action = followVideoSound(viewer);
  expect(viewer.muted).toBe(true);

  viewer.muted = false;
  viewer.dispatchEvent(new Event('volumechange'));

  expect(videoSound.muted).toBe(false);
  action.destroy();
});

it('pauses the video behind the viewer while it is open, and resumes it on close', () => {
  const { video } = mountVideo();
  const play = vi.spyOn(video, 'play').mockResolvedValue();
  const pause = vi.spyOn(video, 'pause').mockImplementation(() => {});
  let paused = true;
  Object.defineProperty(video, 'paused', { configurable: true, get: () => paused });
  observed.at(-1)!([{ isIntersecting: true }]);
  paused = false;
  video.dispatchEvent(new Event('play'));

  const viewer = document.createElement('video');
  const action = followVideoSound(viewer);
  expect(pause).toHaveBeenCalledOnce();

  paused = true;
  action.destroy();
  expect(play).toHaveBeenCalledTimes(2);
});

/**
 * A CONVERSATION'S VIDEO PLAYS WHEN ASKED (user, 2026-10-02, Discord's way: *"ne pas les jouer
 * automatiquement par rapport au scroll, mettre un bouton play ... cliquer sur le bouton play les
 * lance, et cliquer sur une autre part de la video l'ouvre en grand et la lance"*).
 */
function mountManual() {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const onOpen = vi.fn();
  const component = mount(InlineVideo, {
    target,
    props: { src: 'blob:clip', onOpen, openLabel: 'Plein ecran', manualPlay: true },
  });
  mounted.push(() => unmount(component));
  flushSync();
  const video = target.querySelector('video')!;
  const play = vi.spyOn(video, 'play').mockResolvedValue();
  const pause = vi.spyOn(video, 'pause').mockImplementation(() => {});
  /** The first frame is in: the play button is offered from then on. */
  const frameIn = () => {
    video.dispatchEvent(new Event('loadeddata'));
    flushSync();
  };
  const playButton = () => target.querySelector<HTMLButtonElement>('button[aria-label="Lire"]');
  const openButton = () =>
    target.querySelector<HTMLButtonElement>('button[aria-label="Plein ecran"]')!;
  return { target, video, play, pause, onOpen, frameIn, playButton, openButton };
}

it('does NOT start when it scrolls into view', () => {
  const { play, video } = mountManual();
  // The observer an autoplaying video would have built: a manual one builds none.
  expect(observed).toHaveLength(0);
  expect(play).not.toHaveBeenCalled();
  expect(video.loop).toBe(false);
});

it('offers a play button once the first frame is in, and not before', () => {
  const { playButton, frameIn } = mountManual();
  expect(playButton()).toBeNull();
  frameIn();
  expect(playButton()).not.toBeNull();
});

it('the play button starts it where it is, with sound, and opens nothing', () => {
  const { video, play, onOpen, frameIn, playButton } = mountManual();
  frameIn();
  playButton()!.click();
  flushSync();
  expect(play).toHaveBeenCalledTimes(1);
  expect(onOpen).not.toHaveBeenCalled();
  expect(video.muted).toBe(false);
  expect(videoSound.muted).toBe(false);
});

it('hides the play button while it plays, and brings it back when it pauses or ends', () => {
  const { video, frameIn, playButton } = mountManual();
  frameIn();
  video.dispatchEvent(new Event('play'));
  flushSync();
  expect(playButton()).toBeNull();
  video.dispatchEvent(new Event('pause'));
  flushSync();
  expect(playButton()).not.toBeNull();
  video.dispatchEvent(new Event('play'));
  video.dispatchEvent(new Event('ended'));
  flushSync();
  expect(playButton()).not.toBeNull();
});

it('a tap on the rest of the video opens the viewer, which starts it', () => {
  const { openButton, onOpen, play } = mountManual();
  openButton().click();
  expect(onOpen).toHaveBeenCalledTimes(1);
  // The viewer's own player does the playing; the inline element is not asked to.
  expect(play).not.toHaveBeenCalled();
});

it('shows its sound button only while it plays', () => {
  const { video, target, frameIn } = mountManual();
  frameIn();
  const sound = () => target.querySelector('button[aria-pressed]');
  expect(sound()).toBeNull();
  video.dispatchEvent(new Event('play'));
  flushSync();
  expect(sound()).not.toBeNull();
});

/**
 * THEY PLAY TOGETHER (user, 2026-10-02: *"elles jouent ensemble"*, Discord's way): pressing play on a
 * second video does not stop the first. Only a viewer opening silences them.
 */
it('lets several manually started videos play at once', () => {
  const a = mountManual();
  const b = mountManual();
  // The rule pauses only a video that is really playing: make the first one report it.
  Object.defineProperty(a.video, 'paused', { configurable: true, get: () => false });
  a.video.dispatchEvent(new Event('play'));
  b.video.dispatchEvent(new Event('play'));
  expect(a.pause, 'starting the second does not stop the first').not.toHaveBeenCalled();
  expect(b.pause).not.toHaveBeenCalled();
});

it('pauses the ones playing inline when a viewer opens, and leaves them paused when it closes', () => {
  const a = mountManual();
  const b = mountManual();
  for (const v of [a, b]) {
    Object.defineProperty(v.video, 'paused', { configurable: true, get: () => false });
    v.video.dispatchEvent(new Event('play'));
  }
  const viewer = document.createElement('video');
  const action = followVideoSound(viewer);
  expect(a.pause).toHaveBeenCalledTimes(1);
  expect(b.pause).toHaveBeenCalledTimes(1);
  action.destroy();
  expect(a.play).not.toHaveBeenCalled();
  expect(b.play).not.toHaveBeenCalled();
});

it('an autoplaying video is unchanged: loops, plays on screen, shows its sound button', () => {
  const { video, soundButton } = mountVideo();
  expect(video.loop).toBe(true);
  expect(observed).toHaveLength(1);
  expect(soundButton).toBeDefined();
});
