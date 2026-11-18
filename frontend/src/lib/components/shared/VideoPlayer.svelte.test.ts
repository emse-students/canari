// @vitest-environment happy-dom
/**
 * CANARI'S PLAYER REPLACES THE ENGINE'S `controls` IN EVERY VIEWER (user, 2026-10-01).
 *
 * Pinned: no native controls and no native poster ever; the Canari poster covers the box until the
 * first frame is in the element; the controls fade after 2.5 s of playback - UNMOUNTED, so their blur
 * stops paying - and come back on a tap; the keyboard plays, pauses and mutes; and a stream's URL
 * reaches the element untouched. Since the shared kit (owner, 2026-11-09): a tap toggles the sound,
 * a press held pauses while held, the bar is one glass pill and the play disc is glass.
 */
import { it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import VideoPlayer from './VideoPlayer.svelte';
import { VIDEO_SOUND_KEY, videoSound } from '$lib/stores/videoSound.svelte';
import { rememberVideoPosition } from '$lib/utils/videoResume';
import { TRANSPARENT_VIDEO_POSTER } from '$lib/utils/videoPoster';
import { CONTROLS_FADE_MS } from '$lib/utils/videoPlayback';
import { m } from '$lib/paraglide/messages';
import type { AutoplayBlockCause } from '$lib/utils/videoAutoplay';
import { HOLD_TO_PAUSE_MS } from '$lib/actions/videoGestures';

const mounted: (() => void)[] = [];

beforeEach(() => {
  videoSound.setMuted(true);
});
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function mountPlayer(
  src = 'blob:clip',
  soundScope?: 'app' | 'local',
  extra: { streamed?: boolean; declaredDurationMs?: number | null } = {}
) {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(VideoPlayer, { target, props: { src, soundScope, ...extra } });
  mounted.push(() => unmount(component));
  flushSync();
  const root = target.querySelector('[role="group"]') as HTMLElement;
  const video = target.querySelector('video')!;
  return { target, root, video };
}

/** Whether the control bar is up: a faded bar is UNMOUNTED, never a transparent layer. */
const barShown = (target: HTMLElement) => target.querySelector('[data-video-bar]') !== null;

/** A tap as the engine makes one after a pointer press (`detail` 1) - a keyboard click is 0. */
function tap(el: Element) {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
  flushSync();
}

/** Makes the element report it is playing, as the engine would before firing `play`. */
function startPlaying(video: HTMLVideoElement) {
  Object.defineProperty(video, 'paused', { configurable: true, get: () => false });
  video.dispatchEvent(new Event('play'));
  flushSync();
}

it('draws no native controls and no native poster, and its own poster until the first frame', () => {
  const { target, video } = mountPlayer();
  expect(video.hasAttribute('controls')).toBe(false);
  expect(video.getAttribute('poster')).toBe(TRANSPARENT_VIDEO_POSTER);
  expect(target.querySelector('[aria-hidden="true"].bg-linear-to-br')).not.toBeNull();

  video.dispatchEvent(new Event('loadeddata'));
  flushSync();

  expect(target.querySelector('[aria-hidden="true"].bg-linear-to-br')).toBeNull();
});

it('hands a stream its URL exactly as minted', () => {
  const { video } = mountPlayer('blob:stream');
  expect(video.getAttribute('src')).toBe('blob:stream');
});

it('fades the controls after 2.5 s of playback, unmounting them, and a tap brings them back', () => {
  vi.useFakeTimers();
  const { target, video } = mountPlayer();
  startPlaying(video);
  expect(barShown(target)).toBe(true);

  vi.advanceTimersByTime(CONTROLS_FADE_MS - 1);
  flushSync();
  expect(barShown(target)).toBe(true);
  vi.advanceTimersByTime(1);
  flushSync();
  expect(barShown(target)).toBe(false);
  expect(target.querySelector('.glass-video'), 'no blur layer left behind').toBeNull();

  tap(video);
  expect(barShown(target)).toBe(true);
});

it('a tap that FOCUSES the player brings the faded controls back, not up and down again', () => {
  // Mi 9T, 2026-10-01: the tap's focusin raised the controls, its click then read them as up and
  // hid them - the first tap on a playing video did nothing visible.
  vi.useFakeTimers();
  const { target, root, video } = mountPlayer();
  startPlaying(video);
  vi.advanceTimersByTime(CONTROLS_FADE_MS);
  flushSync();
  expect(barShown(target)).toBe(false);

  root.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  flushSync();
  tap(video);
  expect(barShown(target)).toBe(true);
});

it('loops by default, and a loop restarting reads the time from 0 while it keeps playing', () => {
  vi.useFakeTimers();
  const { target, root, video } = mountPlayer();
  expect(video.loop).toBe(true);
  Object.defineProperty(video, 'duration', { configurable: true, get: () => 8 });
  let t = 7.9;
  Object.defineProperty(video, 'currentTime', { configurable: true, get: () => t, set: () => {} });
  startPlaying(video);
  video.dispatchEvent(new Event('timeupdate'));
  flushSync();
  const slider = root.querySelector('[role="slider"]')!;
  expect(slider.getAttribute('aria-valuenow')).toBe('7');

  // The engine wraps to 0 with no `ended` and no `pause`: still playing, so the fade still runs.
  t = 0.1;
  video.dispatchEvent(new Event('timeupdate'));
  flushSync();
  expect(slider.getAttribute('aria-valuenow')).toBe('0');
  vi.advanceTimersByTime(CONTROLS_FADE_MS);
  flushSync();
  expect(barShown(target)).toBe(false);
});

it('keeps the controls while paused', () => {
  vi.useFakeTimers();
  const { target } = mountPlayer();
  vi.advanceTimersByTime(CONTROLS_FADE_MS * 3);
  flushSync();
  expect(barShown(target)).toBe(true);
});

it('plays from the keyboard and from its play button', () => {
  const { root } = mountPlayer();
  root.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);

  const playButton = Array.from(root.querySelectorAll('button')).find(
    (b) =>
      b.getAttribute('aria-label') === m.video_play_label() && b.closest('[data-video-controls]')
  )!;
  playButton.click();
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2);
});

it('its sound button changes the element, which the app-wide answer follows', () => {
  const { root, video } = mountPlayer();
  expect(video.muted).toBe(true);
  const sound = Array.from(root.querySelectorAll('button')).find(
    (b) => b.getAttribute('aria-label') === m.video_sound_label()
  )!;
  sound.click();
  video.dispatchEvent(new Event('volumechange'));
  flushSync();
  expect(video.muted).toBe(false);
  expect(videoSound.muted).toBe(false);
  expect(sound.getAttribute('aria-pressed')).toBe('true');
});

/**
 * A CONVERSATION'S VIEWER HAS ITS OWN SOUND (user, 2026-10-02): audible on open even when the feed
 * left the app-wide answer muted, its button mutes only this video, and the feed's answer is neither
 * read nor written.
 */
it("a conversation's viewer opens audible while the app-wide sound is muted", () => {
  videoSound.setMuted(true);
  const { video } = mountPlayer('blob:clip', 'local');
  expect(video.muted).toBe(false);
});

it("a conversation's viewer mutes only itself and leaves the app-wide answer alone", () => {
  videoSound.setMuted(true);
  const { root, video } = mountPlayer('blob:clip', 'local');
  const sound = Array.from(root.querySelectorAll('button')).find(
    (b) => b.getAttribute('aria-label') === m.video_sound_label()
  )!;
  sound.click();
  video.dispatchEvent(new Event('volumechange'));
  flushSync();
  expect(video.muted).toBe(true);
  expect(sound.getAttribute('aria-pressed')).toBe('false');
  sound.click();
  video.dispatchEvent(new Event('volumechange'));
  flushSync();
  expect(video.muted).toBe(false);
  expect(videoSound.muted).toBe(true);
});

it("a conversation's viewer ignores a later change of the app-wide answer", () => {
  const { video } = mountPlayer('blob:clip', 'local');
  videoSound.setMuted(false);
  videoSound.setMuted(true);
  flushSync();
  expect(video.muted).toBe(false);
});

it('says when the engine refuses the video, instead of a black box', () => {
  const { target, video } = mountPlayer();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  video.dispatchEvent(new Event('error'));
  flushSync();
  expect(target.textContent).toContain(m.video_unplayable());
});

/** A pointer event of the given kind; happy-dom's own PointerEvent is skipped by Svelte's handlers. */
const pointer = (type: string, pointerType: string) =>
  Object.assign(new Event(type, { bubbles: true }), { pointerType });

/**
 * ANY MOUSE MOVEMENT SHOWS THE CONTROLS, A FINGER'S DRAG DOES NOT (user, 2026-10-02: *"sur web,
 * afficher les controles lors de tout mouvement de souris"*). A touch `pointermove` is a swipe in the
 * viewer or a seek on the bar and must never raise anything by itself.
 */
it('a mouse moving anywhere over the player brings the faded controls back', () => {
  vi.useFakeTimers();
  const { target, root, video } = mountPlayer();
  startPlaying(video);
  vi.advanceTimersByTime(CONTROLS_FADE_MS);
  flushSync();
  expect(barShown(target)).toBe(false);

  root.dispatchEvent(pointer('pointermove', 'mouse'));
  flushSync();
  expect(barShown(target)).toBe(true);

  // ... and they fade again once the mouse is still.
  vi.advanceTimersByTime(CONTROLS_FADE_MS);
  flushSync();
  expect(barShown(target)).toBe(false);
});

it('keeps the controls up for as long as the mouse keeps moving', () => {
  vi.useFakeTimers();
  const { target, root, video } = mountPlayer();
  startPlaying(video);
  for (let i = 0; i < 4; i++) {
    vi.advanceTimersByTime(CONTROLS_FADE_MS - 500);
    root.dispatchEvent(pointer('pointermove', 'mouse'));
    flushSync();
  }
  expect(barShown(target)).toBe(true);
});

it('a finger moving over the player shows nothing by itself', () => {
  vi.useFakeTimers();
  const { target, root, video } = mountPlayer();
  startPlaying(video);
  vi.advanceTimersByTime(CONTROLS_FADE_MS);
  flushSync();

  root.dispatchEvent(pointer('pointermove', 'touch'));
  root.dispatchEvent(pointer('pointermove', 'pen'));
  flushSync();
  expect(barShown(target)).toBe(false);
});

/**
 * A TAP ANYWHERE ON THE PLAYER NEVER MUTES (owner, 2026-11-10) - anywhere meaning the black around a
 * letterboxed clip too (user, 2026-10-02): on a MUTED video it turns the sound ON, on any it RAISES
 * the bar, never hides it - the bar goes by itself after the fade. Sound goes off by the speaker.
 */
it('a tap on the black around the picture turns a muted sound on, then pauses - never mutes - and raises the bar', () => {
  vi.useFakeTimers();
  const { target, root, video } = mountPlayer();
  startPlaying(video);
  expect(video.muted).toBe(true);

  tap(root);
  video.dispatchEvent(new Event('volumechange'));
  flushSync();
  expect(video.muted).toBe(false);
  expect(videoSound.muted, "the app's one answer follows").toBe(false);
  expect(target.querySelector('[data-video-glyph="sound-on"]')).not.toBeNull();
  expect(barShown(target)).toBe(true);

  vi.advanceTimersByTime(CONTROLS_FADE_MS);
  flushSync();
  expect(barShown(target)).toBe(false);
  tap(root);
  expect(video.muted, 'a tap on a video with sound never mutes it').toBe(false);
  expect(videoSound.muted).toBe(false);
  expect(
    HTMLMediaElement.prototype.pause,
    'the tap on a video with sound pauses'
  ).toHaveBeenCalled();
  expect(barShown(target), 'a tap raises the faded bar').toBe(true);
});

it('a press held on the picture pauses while held and resumes on release', () => {
  vi.useFakeTimers();
  const { target, root, video } = mountPlayer();
  startPlaying(video);
  vi.mocked(HTMLMediaElement.prototype.play).mockClear();

  root.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, button: 0 }));
  vi.advanceTimersByTime(HOLD_TO_PAUSE_MS);
  expect(HTMLMediaElement.prototype.pause).toHaveBeenCalledTimes(1);
  Object.defineProperty(video, 'paused', { configurable: true, get: () => true });
  video.dispatchEvent(new Event('pause'));
  flushSync();
  expect(target.querySelector('[data-video-play-glyph]'), 'a held pause draws no glyph').toBeNull();

  root.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
  // The click a mouse makes after the hold is not a tap: the sound is left as it was.
  tap(root);
  expect(video.muted).toBe(true);
});

it('a hold on a paused video resumes nothing', () => {
  vi.useFakeTimers();
  const { root } = mountPlayer();
  vi.mocked(HTMLMediaElement.prototype.play).mockClear();
  root.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, button: 0 }));
  vi.advanceTimersByTime(HOLD_TO_PAUSE_MS);
  root.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
  expect(HTMLMediaElement.prototype.pause).not.toHaveBeenCalled();
  expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
});

it("a tap on a control is the control's, and is not the sound tap", () => {
  vi.useFakeTimers();
  const { target, video } = mountPlayer();
  startPlaying(video);
  const playPause = target.querySelector<HTMLButtonElement>('[data-video-bar] button')!;
  playPause.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
  flushSync();
  expect(barShown(target)).toBe(true);
  expect(video.muted).toBe(true);
});

it('draws one glass bar whose buttons wear no blur of their own, and a glass play triangle with no disc', () => {
  // A MOUSE, so the speaker's volume pill is rendered: it too wears the fake glass inside the bar.
  const fine = (q: string) =>
    ({
      matches: true,
      media: q,
      addEventListener() {},
      removeEventListener() {},
    }) as unknown as MediaQueryList;
  vi.stubGlobal('matchMedia', fine);
  window.matchMedia = fine;
  const { target, video } = mountPlayer();
  video.dispatchEvent(new Event('loadeddata'));
  flushSync();
  const pill = target.querySelector<HTMLElement>('[data-video-bar] [data-video-volume]');
  expect(pill, 'the pill is rendered inside the bar').not.toBeNull();
  expect(pill!.dataset.glass, 'the base recipe off iOS: no blur').toBe('fake');
  expect(pill!.className).toContain('glass-video');
  // The buttons draw no chip of their own: the one fake-glass piece inside the bar is the volume pill.
  expect(target.querySelectorAll('[data-video-bar] .glass-video').length).toBe(1);
  expect(target.querySelector('[data-video-bar]')!.className).toContain('glass-video');
  const glyph = target.querySelector('[data-video-play-glyph]')!;
  expect(glyph.querySelector('.glass-video-shape'), 'the resting triangle is flat').toBeNull();
  expect(glyph.querySelector('[data-video-resting-play]')).not.toBeNull();
  expect(glyph.className).not.toMatch(/glass-video|rounded-full|bg-accent/);
});

it('marks its box, which is what the viewer reads to leave the tap to it', () => {
  const { root } = mountPlayer();
  expect(root.hasAttribute('data-video-player')).toBe(true);
});

/**
 * THE CONTROLS ARE AN OVERLAY ON A ZOOMABLE PICTURE (user, 2026-10-02). The viewer hands the zoom
 * down as `--lightbox-zoom` and ONLY the `<video>` applies it: the bar is a sibling, so a zoom never
 * scales it or carries it off the screen.
 */
it('applies the viewer s zoom to the picture alone, never to the controls', () => {
  const { video, target, root } = mountPlayer();
  const bar = target.querySelector('[data-video-controls]') as HTMLElement;
  expect(video.getAttribute('style')).toContain('transform: var(--lightbox-zoom, none)');
  expect(bar.getAttribute('style') ?? '').not.toContain('--lightbox-zoom');
  expect(root.getAttribute('style') ?? '').not.toContain('--lightbox-zoom');
  expect(bar.contains(video)).toBe(false);
});

/**
 * OPENING A VIDEO FULL SCREEN PICKS UP WHERE IT IS (user, 2026-10-02: *"ouvrir une video en grand
 * devrait reprendre la ou elle en est, pas au debut"*). The inline video notes its position
 * (`videoResume`); the player seeks to it once its metadata is in.
 */
function withDuration(video: HTMLVideoElement, seconds: number) {
  Object.defineProperty(video, 'duration', { configurable: true, get: () => seconds });
}

it('resumes where the inline video was, once the duration is known', () => {
  rememberVideoPosition('blob:clip', 12);
  const { video } = mountPlayer('blob:clip');
  withDuration(video, 30);
  expect(video.currentTime, 'nothing is seeked before the metadata').toBe(0);
  video.dispatchEvent(new Event('loadedmetadata'));
  expect(video.currentTime).toBe(12);
});

it('seeks only once: a later metadata event does not drag it back', () => {
  rememberVideoPosition('blob:clip', 12);
  const { video } = mountPlayer('blob:clip');
  withDuration(video, 30);
  video.dispatchEvent(new Event('loadedmetadata'));
  video.currentTime = 20;
  video.dispatchEvent(new Event('loadedmetadata'));
  expect(video.currentTime).toBe(20);
});

it('starts a clip that played to its end from its first frame', () => {
  rememberVideoPosition('blob:ended', 30);
  const { video } = mountPlayer('blob:ended');
  withDuration(video, 30);
  video.dispatchEvent(new Event('loadedmetadata'));
  expect(video.currentTime).toBe(0);
});

it('starts at 0 for a file that was not played inline', () => {
  const { video } = mountPlayer('blob:fresh');
  withDuration(video, 30);
  video.dispatchEvent(new Event('loadedmetadata'));
  expect(video.currentTime).toBe(0);
});

/**
 * THE REEL VIEWER'S MINIMAL PLAYER (user, 2026-10-23): a thin line on the bottom edge and nothing
 * else - no timecode, no control row, no play or sound button - a tap on the picture plays or
 * pauses with a brief glyph that is the tap's feedback and never a state.
 */
function mountMinimal(
  safeBottom = true,
  poster: string | null = null,
  onPlaybackBlocked?: (cause: AutoplayBlockCause | 'unplayable') => void
) {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(VideoPlayer, {
    target,
    props: { src: 'blob:reel', variant: 'reel', safeBottom, poster, onPlaybackBlocked },
  });
  mounted.push(() => unmount(component));
  flushSync();
  const video = target.querySelector('video')!;
  return { target, root: target.querySelector('[role="group"]') as HTMLElement, video };
}

it('minimal: draws a bare line, with no timecode, button or control row', () => {
  const { target, video } = mountMinimal();
  video.dispatchEvent(new Event('loadeddata'));
  flushSync();
  expect(target.querySelectorAll('button').length).toBe(0);
  expect(target.textContent).not.toMatch(/\d:\d\d/);
  const slider = target.querySelector('[role="slider"]')!;
  expect(slider.getAttribute('aria-label')).toBe(m.video_seek_label());
  expect(slider.closest('[data-video-line-slot]')!.className).toContain('z-40');
  expect(target.querySelector('[data-video-line]')!.className).toContain('h-0.5');
  expect(target.querySelector('[data-video-handle]')!.className).toContain('opacity-0');
});

it('minimal: the line pads for the home indicator only when the player reaches the bottom', () => {
  const { target } = mountMinimal(true);
  const bar = target.querySelector<HTMLElement>('[data-video-line-slot]')!;
  expect(bar.getAttribute('style')).toContain('--safe-area-inset-bottom');
  const other = mountMinimal(false);
  expect(other.target.querySelector('[data-video-line-slot]')!.getAttribute('style')).toBeNull();
});

it('minimal: shows no glyph at load, at an engine pause, or at the end', () => {
  const { target, video } = mountMinimal();
  video.dispatchEvent(new Event('loadeddata'));
  video.dispatchEvent(new Event('pause'));
  video.dispatchEvent(new Event('ended'));
  flushSync();
  expect(target.querySelector('[data-video-glyph]')).toBeNull();
});

/**
 * A REEL'S TAP IS THE OVERLAY'S, NOT THE PLAYER'S (owner, 2026-11-18, superseding 2026-11-09): the
 * viewer hides or shows its caption, rail and tabs on a single tap (`reelOverlayTap`), so the
 * player itself neither pauses, mutes nor unmutes - a press held pauses until released, and the rail's
 * speaker is the sound. The one thing a tap still answers is an autoplay the engine REFUSED.
 */
it('minimal: a tap on a playing reel does nothing to the player - no pause, no sound change', () => {
  const { target, root, video } = mountMinimal();
  video.dispatchEvent(new Event('loadeddata'));
  startPlaying(video);
  vi.mocked(HTMLMediaElement.prototype.play).mockClear();
  const muted = video.muted;
  tap(root);
  tap(root);
  flushSync();
  expect(video.muted, 'a tap never changes the sound').toBe(muted);
  expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  expect(HTMLMediaElement.prototype.pause).not.toHaveBeenCalled();
  expect(target.querySelector('[data-video-glyph]'), 'no pop: the player did nothing').toBeNull();
});

it('minimal: a press held pauses the reel and the release resumes it', () => {
  vi.useFakeTimers();
  const { root, video } = mountMinimal();
  video.dispatchEvent(new Event('loadeddata'));
  startPlaying(video);
  vi.mocked(HTMLMediaElement.prototype.play).mockClear();
  root.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, button: 0 }));
  vi.advanceTimersByTime(HOLD_TO_PAUSE_MS);
  expect(HTMLMediaElement.prototype.pause).toHaveBeenCalledTimes(1);
  root.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
});

it('minimal: the keyboard still plays and pauses, with the glyph of what it did', () => {
  const { target, root, video } = mountMinimal();
  video.dispatchEvent(new Event('loadeddata'));
  vi.mocked(HTMLMediaElement.prototype.play).mockClear();
  root.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
  flushSync();
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
  expect(target.querySelector('[data-video-glyph]')!.getAttribute('data-video-glyph')).toBe('play');
});

it('minimal: a loading reel shows its first frame picture, never a play glyph', () => {
  const { target, video } = mountMinimal(true, 'blob:first-frame');
  const poster = target.querySelector('[data-video-first-frame-poster]')!;
  expect(poster.getAttribute('src')).toBe('blob:first-frame');
  expect(target.querySelector('svg.lucide-play, .lucide-play')).toBeNull();
  video.dispatchEvent(new Event('loadeddata'));
  flushSync();
  expect(target.querySelector('[data-video-first-frame-poster]')).toBeNull();
});

it('minimal: with no picture a loading reel is a black box, with no glyph', () => {
  const { target } = mountMinimal();
  expect(target.querySelector('[data-video-first-frame-poster]')).toBeNull();
  expect(target.querySelector('[data-video-play-glyph]')).toBeNull();
});

it('minimal: a play button only when the engine REFUSES the autoplay', async () => {
  const { target, video } = mountMinimal();
  vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(
    new DOMException('no', 'NotAllowedError')
  );
  video.dispatchEvent(new Event('loadeddata'));
  video.dispatchEvent(new Event('canplay'));
  flushSync();
  expect(target.querySelector('button[aria-label]')).toBeNull();
  await Promise.resolve();
  await Promise.resolve();
  flushSync();
  expect(target.querySelector(`button[aria-label="${m.video_play_label()}"]`)).not.toBeNull();
});

/** Lets the `play()` promise of the last load event settle. */
async function settlePlay() {
  for (let i = 0; i < 4; i++) await Promise.resolve();
  flushSync();
}
const playButton = (target: HTMLElement) =>
  target.querySelector(`button[aria-label="${m.video_play_label()}"]`);

it('minimal: an autoplay interrupted by a NEW SOURCE is asked again by its load, and plays', async () => {
  const blocked = vi.fn();
  const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
  const { target, video } = mountMinimal(true, null, blocked);
  const play = vi.mocked(HTMLMediaElement.prototype.play);
  let rejectFirst: (e: unknown) => void = () => {};
  play.mockImplementationOnce(() => new Promise((_, reject) => (rejectFirst = reject)));
  video.dispatchEvent(new Event('loadedmetadata'));
  // THE ENGINE'S ORDER: the new `src` makes the load algorithm reject the pending ask at once, and
  // only QUEUE its `loadstart` - the rejection lands first, and must read the source, not the event.
  video.src = 'blob:reel-stream';
  rejectFirst(new DOMException('no', 'AbortError'));
  await settlePlay();
  expect(play).toHaveBeenCalledTimes(1);
  expect(playButton(target)).toBeNull();
  expect(blocked).not.toHaveBeenCalled();
  expect(String(debug.mock.calls.at(-1)?.[0])).toContain('interrupted by a new source');
  // Then the new load starts, and its first event asks once more - this time it plays.
  video.dispatchEvent(new Event('loadstart'));
  video.dispatchEvent(new Event('loadedmetadata'));
  await settlePlay();
  expect(play).toHaveBeenCalledTimes(2);
  expect(playButton(target)).toBeNull();
  expect(blocked).not.toHaveBeenCalled();
  // Answered: later events of the same load ask nothing.
  video.dispatchEvent(new Event('canplay'));
  await settlePlay();
  expect(play).toHaveBeenCalledTimes(2);
  debug.mockRestore();
});

it('minimal: an autoplay interrupted by a PAUSE (same source) shows the button at once', async () => {
  const blocked = vi.fn();
  const { target, video } = mountMinimal(true, null, blocked);
  vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(
    new DOMException('no', 'AbortError')
  );
  const info = vi.spyOn(console, 'info').mockImplementation(() => {});
  video.dispatchEvent(new Event('loadeddata'));
  await settlePlay();
  // Before 2026-11-04 this waited for a load event that never came: a frozen reel, no button.
  expect(playButton(target)).not.toBeNull();
  expect(blocked).toHaveBeenCalledWith('interrupted');
  expect(String(info.mock.calls[0][0])).toContain('interrupted by a pause');
  info.mockRestore();
});

it('minimal: a refusal before the first frame draws the button over the black box', async () => {
  const blocked = vi.fn();
  const { target, video } = mountMinimal(true, null, blocked);
  vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(
    new DOMException('no', 'NotAllowedError')
  );
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  // Only the metadata: a paused `preload="metadata"` element may never fetch a frame.
  video.dispatchEvent(new Event('loadedmetadata'));
  await settlePlay();
  expect(blocked).toHaveBeenCalledWith('refused');
  expect(playButton(target)).not.toBeNull();
  warn.mockRestore();
});

it('minimal: an autoplay WITH SOUND that is refused plays muted, WARNs, and keeps the stored choice', async () => {
  // Owner, 2026-11-10: the viewer opens with sound where the app may; a refusal falls back to muted
  // for this session (logged), the stored "on" kept, and a tap turns the sound back on.
  videoSound.setMuted(false);
  const blocked = vi.fn();
  const { target, video } = mountMinimal(true, null, blocked);
  expect(video.muted).toBe(false);
  const play = vi.mocked(HTMLMediaElement.prototype.play);
  play.mockRejectedValueOnce(new DOMException('no', 'NotAllowedError'));
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  video.dispatchEvent(new Event('loadedmetadata'));
  await settlePlay();
  expect(play).toHaveBeenCalledTimes(2);
  expect(video.muted).toBe(true);
  expect(videoSound.muted).toBe(true);
  expect(localStorage.getItem(VIDEO_SOUND_KEY)).toBe('on');
  expect(playButton(target)).toBeNull();
  expect(blocked).not.toHaveBeenCalled();
  expect(String(warn.mock.calls[0][0])).toContain('with sound refused');
  warn.mockRestore();
});

it('minimal: the reel viewer is told ONCE that the video is blocked, whatever follows', async () => {
  const blocked = vi.fn();
  const { video } = mountMinimal(true, null, blocked);
  vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(
    new DOMException('no', 'AbortError')
  );
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  video.dispatchEvent(new Event('loadedmetadata'));
  await settlePlay();
  video.dispatchEvent(new Event('error'));
  flushSync();
  expect(blocked).toHaveBeenCalledTimes(1);
  expect(blocked).toHaveBeenCalledWith('interrupted');
});

it('minimal: the autoplay is asked at loadedmetadata, before any data is in', async () => {
  const { video } = mountMinimal();
  const play = vi.mocked(HTMLMediaElement.prototype.play);
  video.dispatchEvent(new Event('loadedmetadata'));
  await settlePlay();
  expect(play).toHaveBeenCalledTimes(1);
});

it('minimal: a slow network draws a spinner, never the play button, until it plays', () => {
  const { target, video } = mountMinimal();
  startPlaying(video);
  video.dispatchEvent(new Event('waiting'));
  flushSync();
  expect(target.querySelector('[data-video-buffering]')).not.toBeNull();
  expect(target.querySelector('[data-video-buffering]')!.getAttribute('aria-label')).toBe(
    m.video_loading_label()
  );
  expect(playButton(target)).toBeNull();
  video.dispatchEvent(new Event('playing'));
  flushSync();
  expect(target.querySelector('[data-video-buffering]')).toBeNull();
});

it('minimal: a paused element waiting for data draws no spinner', () => {
  const { target, video } = mountMinimal();
  video.dispatchEvent(new Event('waiting'));
  flushSync();
  expect(target.querySelector('[data-video-buffering]')).toBeNull();
});

it('minimal: any other autoplay failure shows the button at once, with a warning', async () => {
  const blocked = vi.fn();
  const { target, video } = mountMinimal(true, null, blocked);
  vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(
    new DOMException('no', 'NotSupportedError')
  );
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  video.dispatchEvent(new Event('loadeddata'));
  await settlePlay();
  expect(playButton(target)).not.toBeNull();
  expect(blocked).toHaveBeenCalledTimes(1);
  expect(String(warn.mock.calls[0][0])).toContain('NotSupportedError');
  warn.mockRestore();
});

it('minimal: bytes the engine refuses say the video is blocked', () => {
  const blocked = vi.fn();
  const { video } = mountMinimal(true, null, blocked);
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  video.dispatchEvent(new Event('error'));
  expect(blocked).toHaveBeenCalledWith('unplayable');
  error.mockRestore();
});

it('minimal: the sound follows the app-wide answer changed elsewhere (the rail)', () => {
  const { video } = mountMinimal();
  expect(video.muted).toBe(true);
  videoSound.setMuted(false);
  flushSync();
  expect(video.muted).toBe(false);
});

it('the reel variant draws its video over the WHOLE box, never at its intrinsic size (owner, 2026-11-09)', () => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(VideoPlayer, { target, props: { src: 'blob:clip', variant: 'reel' } });
  mounted.push(() => unmount(component));
  flushSync();
  const video = target.querySelector('video')!;
  expect(video.classList.contains('h-full')).toBe(true);
  expect(video.classList.contains('w-full')).toBe(true);
  expect(video.className).not.toContain('max-h-full');
  expect(video.style.objectFit).toBe('cover');
  expect(video.dataset.reelVideoFit).toBe('cover');
});

// ------------------------------------------------------- a conversation's viewer (owner, 2026-11-10)

function mountConversation(src = 'blob:conv', streamed = false) {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(VideoPlayer, {
    target,
    props: { src, variant: 'conversation', soundScope: 'local', streamed },
  });
  mounted.push(() => unmount(component));
  flushSync();
  const root = target.querySelector('[role="group"]') as HTMLElement;
  const video = target.querySelector('video')!;
  return { target, root, video };
}

/**
 * "MOCHE ET CASSE" (owner, 2026-11-10): the conversation's viewer showed `0:23 / 0:00` in a glass
 * pill. Now: the line on the bottom edge, its speaker in a corner, and no pill, no time, no fade.
 */
it('conversation viewer: a line and a speaker, no bar, no timecode, never looped, nothing fades', () => {
  vi.useFakeTimers();
  const { target, video } = mountConversation();
  expect(barShown(target)).toBe(false);
  expect(target.querySelector('[data-video-progress="line"]')).not.toBeNull();
  expect(target.querySelector(`button[aria-label="${m.video_sound_label()}"]`)).not.toBeNull();
  expect(target.textContent).not.toMatch(/\d:\d\d \/ \d:\d\d/);
  expect(video.loop).toBe(false);
  startPlaying(video);
  vi.advanceTimersByTime(CONTROLS_FADE_MS * 2);
  flushSync();
  expect(target.querySelector('[data-video-progress="line"]')).not.toBeNull();
  expect(barShown(target)).toBe(false);
});

it('conversation viewer: a tap on the picture pauses it and the next plays it', () => {
  const { root, video } = mountConversation();
  startPlaying(video);
  tap(root);
  expect(HTMLMediaElement.prototype.pause).toHaveBeenCalledTimes(1);
  Object.defineProperty(video, 'paused', { configurable: true, get: () => true });
  tap(root);
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
  expect(video.muted, 'the tap is not the sound here').toBe(false);
});

/**
 * ONE GLYPH AT THE CENTRE AT ANY INSTANT (owner, 2026-11-15, "c'est moche"): a pause drew the pop's
 * glass bars AND the resting play triangle together, superimposed. The resting triangle now waits for
 * the pop's own `animationend`. Asserted at every step of a pause and a play (the conversation viewer; the feed, chat and reel share the gate).
 */
const centreGlyphs = (target: HTMLElement) =>
  target.querySelectorAll(
    '[data-video-glyph="play"], [data-video-glyph="pause"], [data-video-play-glyph]'
  ).length;

for (const variant of ['conversation'] as const) {
  it(`${variant}: never two of the play and pause glyphs through a pause and a play`, () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    const target = document.createElement('div');
    document.body.appendChild(target);
    const component = mount(VideoPlayer, {
      target,
      props: { src: 'blob:one-glyph', variant, soundScope: 'local' },
    });
    mounted.push(() => unmount(component));
    flushSync();
    const root = target.querySelector('[role="group"]') as HTMLElement;
    const video = target.querySelector('video')!;
    let paused = true;
    Object.defineProperty(video, 'paused', { configurable: true, get: () => paused });
    video.dispatchEvent(new Event('loadeddata'));
    flushSync();
    expect(centreGlyphs(target), 'at rest, paused: the triangle alone').toBe(1);

    // PLAY: the triangle leaves as the pop comes in.
    tap(root);
    paused = false;
    video.dispatchEvent(new Event('play'));
    flushSync();
    expect(centreGlyphs(target)).toBeLessThanOrEqual(1);
    target.querySelector('[data-video-glyph]')?.dispatchEvent(new Event('animationend'));
    flushSync();
    expect(centreGlyphs(target), 'playing: nothing at the centre').toBe(0);

    // PAUSE: the pop alone, THEN the resting triangle once the pop has ended.
    tap(root);
    paused = true;
    video.dispatchEvent(new Event('pause'));
    flushSync();
    expect(centreGlyphs(target), 'the pause pop and the triangle are never together').toBe(1);
    expect(target.querySelector('[data-video-glyph="pause"]')).not.toBeNull();
    expect(target.querySelector('[data-video-play-glyph]')).toBeNull();
    target.querySelector('[data-video-glyph]')!.dispatchEvent(new Event('animationend'));
    flushSync();
    expect(centreGlyphs(target)).toBe(1);
    expect(target.querySelector('[data-video-play-glyph]'), 'the triangle follows').not.toBeNull();
  });
}

/**
 * "ON NE PEUT PLUS AVANCER DANS LES VIDEOS" (owner, 2026-11-10): a press on the line seeks once the
 * element knows its length - which every file now declares (`mp4Duration.ts`). With no length there
 * is nothing to map the press onto, and the line lands nowhere rather than at a made-up time.
 */
it('the line seeks where it is pressed once the duration is known, and not before', () => {
  const { target, video } = mountConversation();
  const slider = target.querySelector<HTMLElement>('[role="slider"]')!;
  slider.getBoundingClientRect = () => ({ left: 0, width: 200, top: 0, height: 32 }) as DOMRect;
  const press = (x: number) => {
    slider.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, clientX: x, pointerId: 1 })
    );
    slider.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
  };

  withDuration(video, Number.POSITIVE_INFINITY);
  video.dispatchEvent(new Event('durationchange'));
  flushSync();
  press(100);
  expect(video.currentTime, 'no length, no seek').toBe(0);

  withDuration(video, 40);
  video.dispatchEvent(new Event('durationchange'));
  flushSync();
  press(150);
  expect(video.currentTime).toBe(30);
});

/**
 * THE LINE IS FIXED TO THE VIDEO'S TOTAL FROM THE FIRST FRAME (owner, 2026-11-18: on a slow link the
 * line "went back" as segments loaded). It supersedes 2026-11-11, which mapped a stream with no length
 * onto what it had buffered - the very mapping that grows with every segment. A stream whose total
 * nobody knows yet (undeclared, tail not read) draws NO played part and cannot be sought (`unknown`,
 * said once in the log); its length, once the stream learns it, takes over and stays.
 */
it('a stream with no length draws no played part - never a line mapped onto what it has loaded', () => {
  const info = vi.spyOn(console, 'info').mockImplementation(() => {});
  const { target, video } = mountConversation('blob:undeclared-stream', true);
  const slider = target.querySelector<HTMLElement>('[role="slider"]')!;
  slider.getBoundingClientRect = () => ({ left: 0, width: 200, top: 0, height: 32 }) as DOMRect;
  const press = (x: number) => {
    slider.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, clientX: x, pointerId: 1 })
    );
    slider.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
  };
  const ranges = (end: number) => ({ length: 1, start: () => 0, end: () => end });
  let loadedEnd = 8;
  Object.defineProperty(video, 'buffered', { configurable: true, get: () => ranges(loadedEnd) });
  Object.defineProperty(video, 'seekable', { configurable: true, get: () => ranges(loadedEnd) });
  withDuration(video, Number.POSITIVE_INFINITY);
  video.dispatchEvent(new Event('loadedmetadata'));
  flushSync();
  expect(info.mock.calls.map((c) => String(c[0])).join(' ')).not.toContain('no duration');
  const line = target.querySelector<HTMLElement>('[data-video-progress]')!;
  expect(line.getAttribute('data-video-length')).toBe('unknown');
  expect(slider.getAttribute('aria-valuemax'), 'no total, no scale').toBe('0');
  expect(target.querySelector('[data-video-loaded]'), 'no loaded part against nothing').toBeNull();
  press(100);
  expect(video.currentTime, 'no total, no seek').toBe(0);

  // Segments arrive: the line stays as it was - it does not move onto the new loaded end.
  video.currentTime = 3;
  loadedEnd = 24;
  video.dispatchEvent(new Event('progress'));
  flushSync();
  expect(slider.getAttribute('aria-valuemax')).toBe('0');
  expect(target.querySelector<HTMLElement>('[data-video-played]')!.getAttribute('style')).toContain(
    'width: 0%'
  );

  // The stream read 61 s from its tail and set it on the source.
  withDuration(video, 61);
  video.dispatchEvent(new Event('durationchange'));
  flushSync();
  expect(line.getAttribute('data-video-length')).toBe('known');
  expect(slider.getAttribute('aria-valuemax')).toBe('61');
  press(200);
  expect(video.currentTime).toBe(61);
});

it("a stream's line is the PUBLISHER's declared length before the engine knows one, and the played fraction never decreases as segments arrive", () => {
  const { target, video } = mountPlayer('blob:declared-stream', undefined, {
    streamed: true,
    declaredDurationMs: 20_000,
  });
  const ranges = (end: number) => ({ length: 1, start: () => 0, end: () => end });
  let loadedEnd = 2;
  Object.defineProperty(video, 'buffered', { configurable: true, get: () => ranges(loadedEnd) });
  Object.defineProperty(video, 'seekable', { configurable: true, get: () => ranges(loadedEnd) });
  withDuration(video, Number.POSITIVE_INFINITY);
  const widthOf = (selector: string) =>
    Number.parseFloat(
      /width: ([0-9.]+)%/.exec(
        target.querySelector<HTMLElement>(selector)!.getAttribute('style')!
      )![1]
    );
  const playedBar = () => widthOf('[data-video-progress="bar"] [data-video-played]');

  // Fixed from the very first frame, before any media event named a duration.
  video.dispatchEvent(new Event('progress'));
  flushSync();
  expect(
    target.querySelector('[data-video-progress="bar"]')!.getAttribute('data-video-length')
  ).toBe('known');

  let previous = -1;
  const steps: [number, number, number][] = [
    // [playhead, loaded end, engine duration]
    [0, 2, Number.POSITIVE_INFINITY],
    [1.5, 2, Number.POSITIVE_INFINITY],
    [1.5, 6, Number.POSITIVE_INFINITY],
    [3, 9, Number.POSITIVE_INFINITY],
    [3, 13, 20],
    [6, 20, 20],
  ];
  for (const [at, end, duration] of steps) {
    loadedEnd = end;
    video.currentTime = at;
    withDuration(video, duration);
    video.dispatchEvent(new Event('timeupdate'));
    video.dispatchEvent(new Event('progress'));
    flushSync();
    const played = playedBar();
    expect(played, `playhead ${at} s, ${end} s loaded`).toBeGreaterThanOrEqual(previous);
    expect(played).toBeCloseTo((at / 20) * 100, 5);
    previous = played;
  }
  // The loaded part is grey on the same track, under the played part.
  const loaded = target.querySelector<HTMLElement>(
    '[data-video-progress="bar"] [data-video-loaded]'
  )!;
  expect(loaded.getAttribute('style')).toContain('width: 100%');
});

it('the bar draws every loaded range as a grey stretch of the total, none until the total is known', () => {
  const { target, video } = mountPlayer('blob:bar-stream', undefined, { streamed: true });
  const spans = [
    [0, 4],
    [8, 12],
  ];
  const ranges = {
    length: spans.length,
    start: (i: number) => spans[i][0],
    end: (i: number) => spans[i][1],
  };
  Object.defineProperty(video, 'buffered', { configurable: true, get: () => ranges });
  Object.defineProperty(video, 'seekable', { configurable: true, get: () => ranges });
  withDuration(video, Number.POSITIVE_INFINITY);
  video.dispatchEvent(new Event('progress'));
  flushSync();
  const loaded = () => [...target.querySelectorAll<HTMLElement>('[data-video-loaded]')];
  expect(loaded().length).toBe(0);

  withDuration(video, 16);
  video.dispatchEvent(new Event('durationchange'));
  flushSync();
  expect(loaded().map((el) => el.getAttribute('style'))).toEqual([
    'left: 0%; width: 25%;',
    'left: 50%; width: 25%;',
  ]);
});

it('a FILE that declares no length is said, naming that it is the file', () => {
  const info = vi.spyOn(console, 'info').mockImplementation(() => {});
  const { video } = mountConversation('blob:undeclared-file');
  withDuration(video, Number.POSITIVE_INFINITY);
  video.dispatchEvent(new Event('loadedmetadata'));
  expect(info.mock.calls.map((c) => String(c[0])).join(' ')).toContain(
    'the file declares no duration'
  );
});

/**
 * A STREAM NEVER APPENDS A SEGMENT TWICE (review of #3311): a declared duration makes the whole clip
 * seekable to the engine, but what was evicted behind the playhead is gone, and a seek there would
 * wait for ever. The line lands on the earliest time still held instead.
 */
it('a streamed video is never sought before what it still buffers', () => {
  const { target, video } = mountConversation('blob:streamed-conv', true);
  Object.defineProperty(video, 'buffered', {
    configurable: true,
    get: () => ({ length: 1, start: () => 12, end: () => 36 }),
  });
  const slider = target.querySelector<HTMLElement>('[role="slider"]')!;
  slider.getBoundingClientRect = () => ({ left: 0, width: 200, top: 0, height: 32 }) as DOMRect;
  const press = (x: number) => {
    slider.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, clientX: x, pointerId: 1 })
    );
    slider.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
  };
  withDuration(video, 40);
  video.dispatchEvent(new Event('durationchange'));
  flushSync();
  press(20);
  expect(video.currentTime, '4 s was evicted: clamped to 12 s').toBe(12);
  press(150);
  expect(video.currentTime, 'inside what is held: exact').toBe(30);
});
