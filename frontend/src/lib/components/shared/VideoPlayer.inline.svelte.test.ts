// @vitest-environment happy-dom
/**
 * THE INLINE VIDEOS ARE THE SHARED PLAYER'S (owner, 2026-11-09): the feed's and a conversation's
 * video are `VideoPlayer` variants, which replaced `InlineVideo`.
 *
 * Pinned, for the FEED (user, 2026-09-29): it starts at the app's one remembered answer; its speaker
 * and a tap on the picture change that answer for EVERY video, the viewer's included; it plays while
 * it is on screen and pauses when it leaves; the expand chip opens the viewer (never a tap) and notes
 * where the video had got to.
 *
 * For a CONVERSATION (user, 2026-10-02, Discord's way): it plays when its play disc is pressed, never
 * on scroll; it is audible whatever the app-wide answer, and never changes it; it does not loop; two
 * take turns; a tap is its own sound, and goes no further than the player.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import VideoPlayer from './VideoPlayer.svelte';
import { videoSound } from '$lib/stores/videoSound.svelte';
import { takeVideoPosition } from '$lib/utils/videoResume';
import { followVideoSound } from '$lib/actions/playWhileVisible';
import { TRANSPARENT_VIDEO_POSTER } from '$lib/utils/videoPoster';
import { m } from '$lib/paraglide/messages';
import { HOLD_TO_PAUSE_MS } from '$lib/actions/videoGestures';
import { captureVideoFrame } from '$lib/utils/videoFrameBackdrop';

// happy-dom has no canvas to draw a frame on: the capture is the module's, pinned on its own.
vi.mock('$lib/utils/videoFrameBackdrop', () => ({
  captureVideoFrame: vi.fn(() => 'data:image/png;base64,x'),
}));

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
  vi.mocked(captureVideoFrame).mockClear();
});

/** A tap as the engine makes one: a pointer press, then its click (`detail` 1). */
function tap(el: Element) {
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, button: 0 }));
  el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
}

function mountVariant(variant: 'feed' | 'chat', extra: Record<string, unknown> = {}) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const onOpen = vi.fn();
  const component = mount(VideoPlayer, {
    target,
    props: { src: 'blob:clip', variant, onOpen, openLabel: 'Plein ecran', ...extra },
  });
  mounted.push(() => unmount(component));
  flushSync();
  const root = target.querySelector<HTMLElement>('[data-video-player]')!;
  const video = target.querySelector('video')!;
  const openButton = () =>
    target.querySelector<HTMLButtonElement>('button[aria-label="Plein ecran"]')!;
  const soundButton = () =>
    target.querySelector<HTMLButtonElement>(`button[aria-label="${m.video_sound_label()}"]`);
  const playButton = () =>
    target.querySelector<HTMLButtonElement>(`button[aria-label="${m.video_play_label()}"]`);
  /** The first frame is in. */
  const frameIn = () => {
    video.dispatchEvent(new Event('loadeddata'));
    flushSync();
  };
  return { target, root, video, onOpen, openButton, soundButton, playButton, frameIn };
}

// ------------------------------------------------------------------------------------- the feed

it('feed: starts at the app answer, and its speaker answers for every video', () => {
  const first = mountVariant('feed');
  const second = mountVariant('feed');
  expect(first.video.muted).toBe(true);
  // Without it the Android WebView draws its own grey play button until the first frame.
  expect(first.video.getAttribute('poster')).toBe(TRANSPARENT_VIDEO_POSTER);

  first.soundButton()!.click();
  flushSync();

  expect(videoSound.muted).toBe(false);
  expect(second.video.muted).toBe(false);
  expect(first.soundButton()!.getAttribute('aria-pressed')).toBe('true');
});

/**
 * A TAP ON A FEED VIDEO OPENS FULL SCREEN (owner, 2026-11-10, reverting 1.6.9's tap = sound): the
 * CanaReels viewer, on that video, at the time it had reached. The sound stays the speaker's.
 */
it('feed: a tap on the picture opens full screen where it is, and leaves the sound alone', () => {
  const { root, onOpen, video } = mountVariant('feed', { positionKey: 'media-1' });
  video.currentTime = 7;
  tap(root);
  flushSync();
  expect(onOpen).toHaveBeenCalledOnce();
  expect(videoSound.muted).toBe(true);
  expect(takeVideoPosition('media-1')).toBe(7);
});

it('feed with no viewer to open: the tap is the sound, with its glyph', () => {
  const { root, target } = mountVariant('feed', { onOpen: undefined });
  tap(root);
  flushSync();
  expect(videoSound.muted).toBe(false);
  expect(target.querySelector('[data-video-glyph]')!.getAttribute('data-video-glyph')).toBe(
    'sound-on'
  );
});

/**
 * LEAVING FULL SCREEN NEVER RESTARTS THE FEED VIDEO (owner, 2026-11-10): the viewer's player, as it
 * leaves, hands back where it got to, and the feed video that opened it seeks there.
 */
it('feed: the viewer it opened hands back its time as it closes, and the feed video seeks there', () => {
  const feed = mountVariant('feed', { positionKey: 'media-1' });
  feed.video.currentTime = 4;
  feed.openButton().click();
  flushSync();

  const target = document.createElement('div');
  document.body.appendChild(target);
  const viewer = mount(VideoPlayer, {
    target,
    props: { src: 'blob:stream-of-the-viewer', variant: 'reel', positionKey: 'media-1' },
  });
  flushSync();
  const viewerVideo = target.querySelector('video')!;
  Object.defineProperty(viewerVideo, 'duration', { configurable: true, get: () => 40 });
  viewerVideo.dispatchEvent(new Event('loadedmetadata'));
  expect(viewerVideo.currentTime, 'the viewer entered at the feed time').toBe(4);
  viewerVideo.currentTime = 19;
  viewerVideo.dispatchEvent(new Event('timeupdate'));
  flushSync();
  unmount(viewer);

  expect(feed.video.currentTime).toBe(19);
});

/**
 * A STREAMED CARD TAKES THE VIEWER'S TIME ONLY IF IT HOLDS IT (review of #3311): sought outside its
 * buffer it would fetch every segment up to there - a third copy of the clip - or stall behind a cut.
 */
it('feed: a STREAMED card takes the handed-back time only inside what it buffers', () => {
  const feed = mountVariant('feed', { positionKey: 'media-s', src: 'blob:card', streamed: true });
  let ranges: Array<[number, number]> = [[0, 12]];
  Object.defineProperty(feed.video, 'buffered', {
    configurable: true,
    get: () => ({
      length: ranges.length,
      start: (i: number) => ranges[i][0],
      end: (i: number) => ranges[i][1],
    }),
  });
  feed.video.currentTime = 2;
  const openAndHandBack = (seconds: number) => {
    feed.openButton().click();
    flushSync();
    const target = document.createElement('div');
    document.body.appendChild(target);
    const viewer = mount(VideoPlayer, {
      target,
      props: { src: 'blob:viewer', variant: 'reel', positionKey: 'media-s' },
    });
    flushSync();
    const viewerVideo = target.querySelector('video')!;
    Object.defineProperty(viewerVideo, 'duration', { configurable: true, get: () => 40 });
    viewerVideo.dispatchEvent(new Event('loadedmetadata'));
    viewerVideo.currentTime = seconds;
    viewerVideo.dispatchEvent(new Event('timeupdate'));
    flushSync();
    unmount(viewer);
  };

  openAndHandBack(30);
  expect(feed.video.currentTime, '30 s is not buffered here: the card stays').toBe(2);

  ranges = [[0, 35]];
  openAndHandBack(30);
  expect(feed.video.currentTime, 'now held: taken').toBe(30);
});

it('a viewer that was opened from nowhere hands back into nothing', () => {
  const feed = mountVariant('feed', { positionKey: 'media-2' });
  feed.video.currentTime = 3;
  const target = document.createElement('div');
  document.body.appendChild(target);
  const viewer = mount(VideoPlayer, {
    target,
    props: { src: 'blob:x', variant: 'reel', positionKey: 'media-2' },
  });
  flushSync();
  unmount(viewer);
  expect(feed.video.currentTime, 'nobody opened it from the feed').toBe(3);
});

/**
 * THE FIRST FRAME, FROZEN, AND ITS BANDS COME IN TOGETHER (owner, 2026-11-10: a dark box, then the
 * frame with white bands, then the blur - three stages): with a first-frame picture, the blurred
 * bands are drawn from it at once, the element stays invisible until its own frame, and no second
 * capture swaps the bands.
 */
it('feed: draws the first-frame picture and its blurred bands before the video has a frame', () => {
  const { target, video, frameIn } = mountVariant('feed', {
    backdrop: true,
    poster: 'data:image/png;base64,poster',
  });
  expect(target.querySelector('[data-video-first-frame-poster]')).not.toBeNull();
  expect(target.querySelector('[style*="data:image/png;base64,poster"]')).not.toBeNull();
  expect(video.className).toContain('opacity-0');
  frameIn();
  expect(video.className).not.toContain('opacity-0');
  expect(captureVideoFrame).not.toHaveBeenCalled();
  expect(target.querySelector('[data-video-first-frame-poster]')).toBeNull();
});

it('feed: a cropped grid cell crops its poster as it will crop its frame', () => {
  const contained = mountVariant('feed', { poster: 'data:image/png;base64,p' });
  expect(
    contained.target.querySelector('[data-video-first-frame-poster]')!.getAttribute('class')
  ).toContain('object-contain');
  const cell = mountVariant('feed', { poster: 'data:image/png;base64,p', posterFit: 'cover' });
  const poster = cell.target.querySelector('[data-video-first-frame-poster]')!;
  expect(poster.getAttribute('class')).toContain('object-cover');
  expect(poster.getAttribute('class')).not.toContain('object-contain');
});

it("feed: the speaker is the kit's glass chip, yellow only when the sound is on", () => {
  const { soundButton, target } = mountVariant('feed');
  expect(soundButton()!.querySelector('.glass-video')).not.toBeNull();
  expect(target.querySelector('[data-video-sound="off"]')).not.toBeNull();
  soundButton()!.click();
  flushSync();
  expect(target.querySelector('[data-video-sound="on"]')!.getAttribute('class')).toContain(
    'text-accent'
  );
});

it('seeks a decrypted file to its first frame, and hands a stream its URL untouched', () => {
  expect(mountVariant('feed').video.getAttribute('src')).toBe('blob:clip#t=0.1');
  expect(mountVariant('chat').video.getAttribute('src')).toBe('blob:clip#t=0.1');
  // An MSE URL with a fragment is a URL no MediaSource answers to: Chromium refuses it with
  // MEDIA_ERR_SRC_NOT_SUPPORTED before `sourceopen` (measured on the Mi 9T, 2026-10-01).
  const stream = mountVariant('feed', { src: 'blob:stream', streamed: true });
  expect(stream.video.getAttribute('src')).toBe('blob:stream');
});

it('feed: loops, muted and inline, never by the autoplay attribute, and draws no play disc', () => {
  const { video, playButton, frameIn } = mountVariant('feed');
  expect(video.loop).toBe(true);
  expect(video.muted).toBe(true);
  expect(video.autoplay).toBe(false);
  expect(video.hasAttribute('playsinline')).toBe(true);
  expect(video.hasAttribute('controls')).toBe(false);
  frameIn();
  expect(playButton(), 'it plays by being on screen').toBeNull();
});

it("covers the box with Canari's poster until the first frame, never the engine's", () => {
  const { frameIn } = mountVariant('feed');
  const poster = () => document.querySelector('[aria-hidden="true"].bg-linear-to-br');
  expect(poster()).not.toBeNull();
  expect(poster()!.className).toContain('pointer-events-none');
  frameIn();
  expect(poster()).toBeNull();
});

it('feed: plays while it is on screen and pauses when it leaves', () => {
  const { video } = mountVariant('feed');
  const play = vi.spyOn(video, 'play').mockResolvedValue();
  const pause = vi.spyOn(video, 'pause').mockImplementation(() => {});
  Object.defineProperty(video, 'paused', { configurable: true, get: () => false });

  observed.at(-1)!([{ isIntersecting: true }]);
  observed.at(-1)!([{ isIntersecting: false }]);

  expect(play).toHaveBeenCalledOnce();
  expect(pause).toHaveBeenCalledOnce();
});

it('feed: the expand chip opens the viewer, and the speaker does not', () => {
  const { openButton, soundButton, onOpen } = mountVariant('feed');
  soundButton()!.click();
  expect(onOpen).not.toHaveBeenCalled();
  openButton().click();
  expect(onOpen).toHaveBeenCalledOnce();
});

it('feed: the `f` key opens the viewer - an inline video has no other full screen', () => {
  const { root, onOpen } = mountVariant('feed');
  root.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', bubbles: true }));
  expect(onOpen).toHaveBeenCalledOnce();
});

it('pauses the feed video behind a viewer while it is open, and resumes it on close', () => {
  const { video } = mountVariant('feed');
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

/** OPENING IT FULL SCREEN NOTES WHERE IT IS, for the viewer's player to resume (`videoResume`). */
it('notes its position when the viewer is opened, so the viewer resumes there', () => {
  const { video, openButton, onOpen } = mountVariant('feed');
  video.currentTime = 12;
  openButton().click();
  expect(onOpen).toHaveBeenCalledTimes(1);
  expect(takeVideoPosition('blob:clip')).toBe(12);
});

it('notes nothing for a video that has not played, and takes no position itself', () => {
  const { openButton } = mountVariant('feed');
  openButton().click();
  expect(takeVideoPosition('blob:clip')).toBe(0);
});

it('fills the bands of a contained clip with its own first frame, when asked', () => {
  const { frameIn, target } = mountVariant('feed', { backdrop: true });
  frameIn();
  expect(captureVideoFrame).toHaveBeenCalledOnce();
  expect(target.querySelector('[style*="data:image/png;base64,x"]')).not.toBeNull();
});

it('hands the caller its element and its metadata', () => {
  const onVideo = vi.fn();
  const onMetadata = vi.fn();
  const { video } = mountVariant('chat', { onVideo, onMetadata });
  expect(onVideo).toHaveBeenCalledWith(video);
  video.dispatchEvent(new Event('loadedmetadata'));
  expect(onMetadata).toHaveBeenCalledOnce();
});

// ------------------------------------------------------------------------------ a conversation

it('chat: does NOT start when it scrolls into view, and does not loop', () => {
  const { video } = mountVariant('chat');
  const play = vi.spyOn(video, 'play').mockResolvedValue();
  // The observer a feed video would have built: a conversation's builds none.
  expect(observed).toHaveLength(0);
  expect(play).not.toHaveBeenCalled();
  expect(video.loop).toBe(false);
  expect(video.autoplay).toBe(false);
});

it('chat: offers the glass play triangle once the first frame is in, and not before', () => {
  const { playButton, frameIn } = mountVariant('chat');
  expect(playButton()).toBeNull();
  frameIn();
  expect(playButton()).not.toBeNull();
  expect(playButton()!.querySelector('.glass-video-shape')).not.toBeNull();
});

it('chat: the glyph starts it where it is, with sound, and opens nothing', () => {
  const { video, onOpen, frameIn, playButton } = mountVariant('chat');
  const play = vi.spyOn(video, 'play').mockResolvedValue();
  frameIn();
  playButton()!.click();
  flushSync();
  expect(play).toHaveBeenCalledTimes(1);
  expect(onOpen).not.toHaveBeenCalled();
  expect(video.muted).toBe(false);
});

/**
 * A CONVERSATION'S VIDEO IS NOT THE FEED'S (user, 2026-10-02: tapping its sound button changed ALL
 * the buttons on the page). It starts audible whatever the app-wide answer is, and never changes it.
 */
it('chat: is audible while the app answer is muted, and its own sound leaves that answer alone', () => {
  const feed = mountVariant('feed');
  const chat = mountVariant('chat');
  expect(chat.video.muted).toBe(false);
  chat.video.dispatchEvent(new Event('play'));
  flushSync();
  chat.soundButton()!.click();
  chat.video.dispatchEvent(new Event('volumechange'));
  flushSync();
  expect(chat.video.muted).toBe(true);
  expect(videoSound.muted).toBe(true);
  tap(chat.root);
  flushSync();
  expect(chat.video.muted).toBe(false);
  expect(videoSound.muted, 'the tap is local too').toBe(true);
  expect(feed.video.muted).toBe(true);
});

it('chat: does not follow the app-wide answer either way', () => {
  const { video } = mountVariant('chat');
  videoSound.setMuted(false);
  flushSync();
  videoSound.setMuted(true);
  flushSync();
  expect(video.muted).toBe(false);
});

it('chat: the disc goes while it plays and comes back when it pauses; the line and speaker stay', () => {
  const { video, target, frameIn, playButton, soundButton } = mountVariant('chat');
  let paused = true;
  Object.defineProperty(video, 'paused', { configurable: true, get: () => paused });
  frameIn();
  expect(soundButton(), 'before the first play, the disc is the whole offer').toBeNull();
  paused = false;
  video.dispatchEvent(new Event('play'));
  flushSync();
  expect(playButton()).toBeNull();
  expect(soundButton()).not.toBeNull();
  expect(target.querySelector('[data-video-line-slot]')).not.toBeNull();
  paused = true;
  video.dispatchEvent(new Event('pause'));
  flushSync();
  expect(playButton()).not.toBeNull();
  expect(soundButton()).not.toBeNull();
});

it("chat: a tap on the picture goes no further - a bubble's info panel never opens", () => {
  const { root, video } = mountVariant('chat');
  vi.spyOn(video, 'play').mockResolvedValue();
  const bubble = vi.fn();
  document.body.addEventListener('click', bubble);
  tap(root);
  document.body.removeEventListener('click', bubble);
  expect(bubble).not.toHaveBeenCalled();
});

it('chat: the expand chip opens the viewer, which does the playing', () => {
  const { openButton, onOpen, video } = mountVariant('chat');
  const play = vi.spyOn(video, 'play').mockResolvedValue();
  openButton().click();
  expect(onOpen).toHaveBeenCalledTimes(1);
  expect(play).not.toHaveBeenCalled();
});

/**
 * THEY TAKE TURNS (user, 2026-10-02, reversing #1341: *"commencer une video doit en arreter une
 * autre"*): pressing play on a second video PAUSES the first. The whole rule is pinned in
 * `playbackArbiter.test.ts`.
 */
it('chat: pauses the first started video when a second one starts', () => {
  const a = mountVariant('chat');
  const b = mountVariant('chat');
  const pauseA = vi.spyOn(a.video, 'pause').mockImplementation(() => {});
  const pauseB = vi.spyOn(b.video, 'pause').mockImplementation(() => {});
  Object.defineProperty(a.video, 'paused', { configurable: true, get: () => false });
  a.video.dispatchEvent(new Event('play'));
  b.video.dispatchEvent(new Event('play'));
  expect(pauseA, 'starting the second stops the first').toHaveBeenCalledTimes(1);
  expect(pauseB).not.toHaveBeenCalled();
});

it('chat: a viewer opening pauses the one playing inline, and closing leaves it paused', () => {
  const a = mountVariant('chat');
  const play = vi.spyOn(a.video, 'play').mockResolvedValue();
  const pause = vi.spyOn(a.video, 'pause').mockImplementation(() => {});
  Object.defineProperty(a.video, 'paused', { configurable: true, get: () => false });
  a.video.dispatchEvent(new Event('play'));
  const viewer = document.createElement('video');
  const action = followVideoSound(viewer);
  expect(pause).toHaveBeenCalledTimes(1);
  action.destroy();
  expect(play).not.toHaveBeenCalled();
});

/**
 * A real element's play and pause, as the arbiter and the feed read them: `paused` follows the
 * calls, and each fires its event.
 */
function liveElement(video: HTMLVideoElement) {
  let paused = true;
  Object.defineProperty(video, 'paused', { configurable: true, get: () => paused });
  const play = vi.spyOn(video, 'play').mockImplementation(async () => {
    paused = false;
    video.dispatchEvent(new Event('play'));
  });
  const pause = vi.spyOn(video, 'pause').mockImplementation(() => {
    paused = true;
    video.dispatchEvent(new Event('pause'));
  });
  return { play, pause };
}

/**
 * A PAUSE THE READER MADE STAYS MADE (stack review, 2026-11-09): the feed's own idle resume used to
 * replay the video just paused - its `pause` event said "nothing plays", and the video last come into
 * view was that one. Driven through the REAL `playWhileVisible` and arbiter.
 */
describe('feed: the reader pauses, and the feed does not undo it', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('a hold pauses it until released', () => {
    const { root, video } = mountVariant('feed');
    const { play, pause } = liveElement(video);
    observed.at(-1)!([{ isIntersecting: true }]);
    expect(play).toHaveBeenCalledTimes(1);

    root.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, button: 0 }));
    vi.advanceTimersByTime(HOLD_TO_PAUSE_MS);
    expect(pause).toHaveBeenCalledTimes(1);
    expect(play, 'the feed replays nothing while it is held').toHaveBeenCalledTimes(1);
    expect(video.paused).toBe(true);

    root.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
    expect(play, 'the release resumes it').toHaveBeenCalledTimes(2);
  });

  it('Space pauses it, and it stays paused until it leaves the screen and comes back', () => {
    const { root, video } = mountVariant('feed');
    const { play } = liveElement(video);
    observed.at(-1)!([{ isIntersecting: true }]);
    root.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    expect(video.paused).toBe(true);
    expect(play).toHaveBeenCalledTimes(1);

    observed.at(-1)!([{ isIntersecting: true }]);
    expect(play, 'a new intersection report while still on screen').toHaveBeenCalledTimes(1);
    observed.at(-1)!([{ isIntersecting: false }]);
    observed.at(-1)!([{ isIntersecting: true }]);
    expect(play, 'scrolled away and back: it plays as any other').toHaveBeenCalledTimes(2);
  });
});

it('feed with no viewer: a tap on a video on screen but paused gives the sound and plays it', () => {
  const { root, video } = mountVariant('feed', { onOpen: undefined });
  const { play } = liveElement(video);
  tap(root);
  flushSync();
  expect(videoSound.muted).toBe(false);
  expect(play).toHaveBeenCalledTimes(1);
});

it('chat: the first tap plays it, audible, as the disc does - and the next is its sound', () => {
  const { root, video, target } = mountVariant('chat');
  const { play } = liveElement(video);
  tap(root);
  flushSync();
  expect(play).toHaveBeenCalledTimes(1);
  expect(video.muted).toBe(false);
  expect(target.querySelector('[data-video-glyph]')!.getAttribute('data-video-glyph')).toBe('play');
  tap(root);
  flushSync();
  expect(video.muted, 'started: the tap is its sound').toBe(true);
  expect(play).toHaveBeenCalledTimes(1);
  expect(videoSound.muted, 'its own sound, never the app').toBe(true);
});

it('chat: once started, a pause chip pauses it and plays it again', () => {
  const { target, video } = mountVariant('chat');
  const { play, pause } = liveElement(video);
  void video.play();
  flushSync();
  const toggle = () => target.querySelector<HTMLButtonElement>('[data-video-toggle]')!;
  expect(toggle().getAttribute('aria-label')).toBe(m.video_pause_label());
  toggle().click();
  flushSync();
  expect(pause).toHaveBeenCalledTimes(1);
  expect(toggle().getAttribute('aria-label')).toBe(m.video_play_label());
  toggle().click();
  expect(play).toHaveBeenCalledTimes(2);
});

it("chat: the message's actions are a chip, given by the bubble, since a hold is the pause", () => {
  const onActions = vi.fn();
  const { target } = mountVariant('chat', { onActions });
  const chip = target.querySelector<HTMLButtonElement>('[data-video-actions]')!;
  expect(chip.getAttribute('aria-label')).toBe(m.msg_more_actions_label());
  chip.click();
  expect(onActions).toHaveBeenCalledOnce();
  expect(mountVariant('chat').target.querySelector('[data-video-actions]')).toBeNull();
});
