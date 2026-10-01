/**
 * A TAP ON A VIDEO IS THE PLAYER'S, ANYWHERE ON IT (user, 2026-10-02: *"sur mobile un appui n'importe
 * ou sur l'ecran de la video ouverte en grand est un toggle des controles"*).
 *
 * The viewer already left a tap on the `<video>` or on the control bar alone (`NOT_A_GESTURE`), but
 * the black around a letterboxed clip is the player's root, not the video: a tap there was the
 * VIEWER's - it cancelled the browser's click and toggled its own title bar, so the player's
 * controls never answered on most of a phone's screen. A touch that starts inside `[data-video-player]`
 * now keeps its click, which is the player's toggle. A swipe from there is still the viewer's.
 */
import { describe, it, expect, afterAll, afterEach } from 'vitest';
import { tick } from 'svelte';
import { createRawSnippet, flushSync, mount, unmount } from 'svelte';
import MediaLightbox from './MediaLightbox.svelte';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';

// The viewer fades out; happy-dom rejects a cancelled animation, see the helper.
afterAll(adoptTransitionAnimations());

const mounted: (() => void)[] = [];

const photo = createRawSnippet(() => ({
  render: () =>
    '<div><img id="photo" alt="" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" /></div>',
}));

const content = createRawSnippet(() => ({
  render: () =>
    '<div><div data-video-player id="player"><video></video></div><div id="picture">x</div></div>',
}));

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

function open(children = content): void {
  const instance = mount(MediaLightbox, {
    target: document.body,
    props: { open: true, onClose: () => {}, children },
  });
  mounted.push(() => unmount(instance));
  flushSync();
}

/** A touch sequence at one point; returns the `touchend`, whose `defaultPrevented` is the answer. */
function tap(target: Element): Event {
  const point = { clientX: 100, clientY: 200 };
  const make = (type: string, touches: unknown[]) =>
    Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
      touches,
      changedTouches: [point],
    });
  target.dispatchEvent(make('touchstart', [point]));
  const end = make('touchend', []);
  target.dispatchEvent(end);
  return end;
}

describe('MediaLightbox - a tap inside a video player', () => {
  it('keeps its click, so the player can toggle its controls', () => {
    open();
    const end = tap(document.getElementById('player')!);
    expect(end.defaultPrevented, 'the click is left to the player').toBe(false);
  });

  it('still takes a tap anywhere else for its own: the click is cancelled', () => {
    open();
    const end = tap(document.getElementById('picture')!);
    expect(end.defaultPrevented, 'the viewer handles it').toBe(true);
  });
});

/**
 * A VIDEO IS NEVER ZOOMED (user, 2026-10-02: *"les controles video ne doivent pas etre affectes par
 * le zoom, desactive aussi le clic pour zoomer sur les videos"*). The player sits inside the
 * transform wrapper, so a zoom scaled its control bar with it. Every zoom goes through `zoomAt`; it
 * refuses while the frame holds a player. A photo still zooms - the control case.
 */
describe('MediaLightbox - zoom', () => {
  const frame = () =>
    document.querySelector<HTMLElement>('[role="presentation"][style*="scale("]')!;
  const scaleOf = () => Number(/scale\(([\d.]+)\)/.exec(frame().style.transform)?.[1] ?? 1);
  const wheelUp = () =>
    frame().dispatchEvent(
      new WheelEvent('wheel', { deltaY: -800, bubbles: true, cancelable: true })
    );
  const doubleClick = (target: Element) =>
    target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));

  it('zooms a photo on the wheel and on a double-click (the control case)', async () => {
    open(photo);
    await tick();
    wheelUp();
    flushSync();
    expect(scaleOf()).toBeGreaterThan(1);
  });

  it('zooms a photo on a double-click', async () => {
    open(photo);
    await tick();
    doubleClick(document.getElementById('photo')!);
    flushSync();
    expect(scaleOf()).toBeGreaterThan(1);
  });

  it('does not zoom a video on the wheel', async () => {
    open();
    await tick();
    wheelUp();
    flushSync();
    expect(scaleOf()).toBe(1);
  });

  it('does not zoom a video on a double-click, on the picture or on the margin', async () => {
    open();
    await tick();
    doubleClick(document.getElementById('player')!);
    doubleClick(document.getElementById('picture')!);
    flushSync();
    expect(scaleOf()).toBe(1);
  });

  it('does not offer the zoom-in cursor over a video', async () => {
    open();
    await tick();
    expect(frame().style.cursor).not.toBe('zoom-in');
    document.body.innerHTML = '';
    open(photo);
    await tick();
    expect(frame().style.cursor).toBe('zoom-in');
  });
});
