/**
 * ONE MEDIA PLAYS AT A TIME, IN THE WHOLE APP (user, 2026-10-02).
 *
 * Pinned: a media that starts pauses every other one (video<->video, voice<->voice, video<->voice,
 * feed<->conversation) WITHOUT resetting it; the feed's muted background video yields and is not
 * started over a media the reader chose, then picks up again once it is quiet; a refused play pauses
 * nobody; a viewer takes over and gives the feed back; the recorder silences playback; nothing is
 * left registered after destroy.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  arbitratePlayback,
  isForegroundPlaying,
  pausePlayback,
} from '$lib/actions/playbackArbiter';
import { followVideoSound, playWhileVisible } from '$lib/actions/playWhileVisible';

const runtime = vi.hoisted(() => ({ mobile: false }));
vi.mock('$lib/utils/appVersion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/appVersion')>()),
  isMobileTauriRuntime: () => runtime.mobile,
}));

type Fake<T extends HTMLMediaElement> = T & { startPlaying(): void; position: number };
const teardown: (() => void)[] = [];
let observed: ((entries: { isIntersecting: boolean }[]) => void)[] = [];

/** A media element that behaves like a real one: `play()` raises `play`, `pause()` raises `pause`. */
function fake<T extends HTMLMediaElement>(el: T): Fake<T> {
  let paused = true;
  Object.defineProperty(el, 'paused', { configurable: true, get: () => paused });
  const f = el as Fake<T>;
  f.position = 0;
  f.startPlaying = () => {
    paused = false;
    el.dispatchEvent(new Event('play'));
  };
  el.play = vi.fn(() => {
    f.startPlaying();
    return Promise.resolve();
  });
  el.pause = vi.fn(() => {
    if (paused) return;
    paused = true;
    el.dispatchEvent(new Event('pause'));
  });
  return f;
}

function register<T extends HTMLMediaElement>(el: T, ambient = false) {
  const f = fake(el);
  const reg = arbitratePlayback(f, { ambient });
  teardown.push(() => reg.destroy());
  return f;
}
const video = (ambient = false) => register(document.createElement('video'), ambient);
const voice = () => register(document.createElement('audio'));

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
});

afterEach(() => {
  while (teardown.length) teardown.pop()!();
  vi.unstubAllGlobals();
  runtime.mobile = false;
  Reflect.deleteProperty(document, 'visibilityState');
  Reflect.deleteProperty(window, '__canariForeground');
});

it('video <-> video: starting one pauses the other, which keeps its position and ends nothing', () => {
  const a = video();
  const b = video();
  const ended = vi.fn();
  a.addEventListener('ended', ended);
  a.position = 12;
  a.startPlaying();
  b.startPlaying();
  expect(a.paused).toBe(true);
  expect(b.paused).toBe(false);
  expect(a.position).toBe(12);
  expect(ended).not.toHaveBeenCalled();
});

it('voice <-> voice, and video <-> voice, take turns both ways', () => {
  const v1 = voice();
  const v2 = voice();
  const clip = video();
  v1.startPlaying();
  v2.startPlaying();
  expect([v1.paused, v2.paused]).toEqual([true, false]);
  clip.startPlaying();
  expect([v2.paused, clip.paused]).toEqual([true, false]);
  v1.startPlaying();
  expect([clip.paused, v1.paused]).toEqual([true, false]);
});

it('a native-control or programmatic play claims like a button does', () => {
  const a = voice();
  const b = voice();
  a.startPlaying();
  void b.play();
  expect(a.paused).toBe(true);
});

it('a refused play raises no play event and pauses nobody', () => {
  const a = voice();
  const b = voice();
  a.startPlaying();
  b.play = vi.fn(() => Promise.reject(new DOMException('refused', 'NotAllowedError')));
  void b.play().catch(() => {});
  expect(a.paused).toBe(false);
});

it('a media that was already paused is not paused again', () => {
  const a = voice();
  const b = voice();
  b.startPlaying();
  expect(a.pause).not.toHaveBeenCalled();
});

it('unregisters on destroy: an element that is gone claims and yields nothing', () => {
  const a = voice();
  const gone = document.createElement('audio');
  const f = fake(gone);
  const reg = arbitratePlayback(f);
  reg.destroy();
  a.startPlaying();
  f.startPlaying();
  expect(a.paused, 'an unregistered element does not claim').toBe(false);
  expect(isForegroundPlaying()).toBe(true);
});

it('the feed: a muted ambient video yields to a conversation media and is not started over it', () => {
  const feed = fake(document.createElement('video'));
  feed.muted = true;
  const observer = playWhileVisible(feed);
  teardown.push(() => observer.destroy?.());
  observed.at(-1)!([{ isIntersecting: true }]);
  expect(feed.paused, 'plays on screen when nothing else does').toBe(false);

  const note = voice();
  note.startPlaying();
  expect(feed.paused, 'a media of the reader pauses the background').toBe(true);

  observed.at(-1)!([{ isIntersecting: false }]);
  observed.at(-1)!([{ isIntersecting: true }]);
  expect(feed.paused, 'scrolling into view does not steal playback back').toBe(true);
  expect(note.paused).toBe(false);
});

it('the feed picks the video on screen up again once the media quiets down', () => {
  const feed = fake(document.createElement('video'));
  const observer = playWhileVisible(feed);
  teardown.push(() => observer.destroy?.());
  observed.at(-1)!([{ isIntersecting: true }]);
  const note = voice();
  note.startPlaying();
  expect(feed.paused).toBe(true);
  note.pause();
  expect(feed.paused, 'the voice note was paused by its reader: the feed returns').toBe(false);
});

it('an ambient video that starts under a foreground media gives way instead of pausing it', () => {
  const note = voice();
  note.startPlaying();
  const bg = video(true);
  bg.startPlaying();
  expect(bg.paused).toBe(true);
  expect(note.paused).toBe(false);
});

it('two ambient videos still take turns among themselves', () => {
  const a = video(true);
  const b = video(true);
  a.startPlaying();
  b.startPlaying();
  expect([a.paused, b.paused]).toEqual([true, false]);
});

it('a viewer opening pauses an inline video, and closing it gives the feed back', () => {
  const feed = fake(document.createElement('video'));
  const observer = playWhileVisible(feed);
  teardown.push(() => observer.destroy?.());
  observed.at(-1)!([{ isIntersecting: true }]);
  const inline = video();
  inline.startPlaying();
  expect(feed.paused).toBe(true);

  const viewer = fake(document.createElement('video'));
  const action = followVideoSound(viewer, 'local');
  expect(inline.paused).toBe(true);
  viewer.startPlaying();
  action.destroy();
  expect(feed.paused, 'the viewer closed: the video on screen returns').toBe(false);
  expect(inline.paused, 'what the reader started inline stays paused').toBe(true);
});

it('the recorder silences every playing media, and the media can play again afterwards', () => {
  const a = voice();
  const b = video();
  a.startPlaying();
  pausePlayback(undefined, false, 'test recorder');
  expect([a.paused, b.paused]).toEqual([true, true]);
  a.startPlaying();
  expect(a.paused).toBe(false);
});

/** Moves the page's visibility and announces it, as a tab switch does. */
function setPageVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

/** What `MainActivity` does on `onPause`/`onResume`: the flag, then the event. */
function setForeground(foreground: boolean) {
  Reflect.set(window, '__canariForeground', foreground);
  window.dispatchEvent(new CustomEvent('canari:foreground', { detail: { foreground } }));
}

it('a web page leaving the screen pauses the ambient video, keeps the voice note, and the feed returns with it', () => {
  const feed = fake(document.createElement('video'));
  const observer = playWhileVisible(feed);
  teardown.push(() => observer.destroy?.());
  observed.at(-1)!([{ isIntersecting: true }]);
  const note = voice();
  expect(feed.paused).toBe(false);
  setPageVisibility('hidden');
  expect(feed.paused, 'nobody watches a muted feed behind another tab').toBe(true);
  note.startPlaying();
  expect(note.paused, 'what the reader started keeps playing on web').toBe(false);
  note.pause();
  expect(feed.paused, 'idle off screen brings nothing back').toBe(true);
  setPageVisibility('visible');
  expect(feed.paused, 'back on screen: the ambient video resumes').toBe(false);
});

it('on Android, the app leaving the screen pauses every media, the voice note included', () => {
  runtime.mobile = true;
  const note = voice();
  note.startPlaying();
  setForeground(false);
  expect(note.paused).toBe(true);
  setForeground(true);
  expect(note.paused, 'coming back resumes nothing the reader chose').toBe(true);
});
