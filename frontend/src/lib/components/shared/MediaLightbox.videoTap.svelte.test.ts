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
import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
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
    '<div><div data-video-player id="player"><video id="clip"></video></div><div id="picture">x</div></div>',
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

  it('keeps the click of a tap on the picture itself - the video is not on the viewer s exclusion list any more', () => {
    open();
    const end = tap(document.getElementById('clip')!);
    expect(end.defaultPrevented).toBe(false);
  });
});

/**
 * THE CONTROLS ARE AN OVERLAY ON A ZOOMABLE, MOVABLE PICTURE (user, 2026-10-02: *"les controles
 * devraient etre une ui par dessus l'element video zoomable et deplacable"*).
 *
 * The player sits inside the transform wrapper, so zooming the wrapper scaled its control bar. For a
 * frame that holds a player the wrapper keeps only the swipe and the dismiss, and the zoom reaches
 * the `<video>` through `--lightbox-zoom`. A photo is unchanged.
 */
describe('MediaLightbox - zoom with a video player', () => {
  const frame = () =>
    document.querySelector<HTMLElement>('[role="presentation"][style*="scale("]')!;
  const wrapperScale = () => Number(/scale\(([\d.]+)\)/.exec(frame().style.transform)?.[1] ?? 1);
  const zoomVar = () => frame().style.getPropertyValue('--lightbox-zoom');
  const wheelUp = () =>
    frame().dispatchEvent(
      new WheelEvent('wheel', { deltaY: -800, bubbles: true, cancelable: true })
    );
  const doubleClick = (target: Element) =>
    target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));

  it('zooms a photo through the wrapper, as it always did', async () => {
    open(photo);
    await tick();
    wheelUp();
    flushSync();
    expect(wrapperScale()).toBeGreaterThan(1);
    expect(zoomVar()).toBe('none');
  });

  it('zooms a video through the picture alone: the wrapper, which holds the controls, stays at 1', async () => {
    open();
    await tick();
    wheelUp();
    flushSync();
    expect(wrapperScale()).toBe(1);
    const match = /scale\(([\d.]+)\)/.exec(zoomVar());
    expect(Number(match?.[1])).toBeGreaterThan(1);
  });

  it('a double-click does not start a zoom on a video, but still does on a photo', async () => {
    open();
    await tick();
    doubleClick(document.getElementById('player')!);
    doubleClick(document.getElementById('picture')!);
    flushSync();
    expect(zoomVar()).toContain('scale(1)');
    document.body.innerHTML = '';

    open(photo);
    await tick();
    doubleClick(document.getElementById('photo')!);
    flushSync();
    expect(wrapperScale()).toBeGreaterThan(1);
  });

  it('offers no zoom-in cursor over a video, and one over a photo', async () => {
    open();
    await tick();
    expect(frame().style.cursor).toBe('default');
    document.body.innerHTML = '';
    open(photo);
    await tick();
    expect(frame().style.cursor).toBe('zoom-in');
  });

  it('swallows the click that ends a mouse pan, and only that one', async () => {
    HTMLElement.prototype.setPointerCapture = () => {};
    open();
    await tick();
    wheelUp();
    flushSync();

    const clip = document.getElementById('clip')!;
    const clicked = vi.fn();
    clip.addEventListener('click', clicked);
    const pointer = (type: string, x: number) =>
      Object.assign(new Event(type, { bubbles: true }), {
        pointerType: 'mouse',
        pointerId: 1,
        button: 0,
        clientX: x,
        clientY: 0,
      });
    clip.dispatchEvent(pointer('pointerdown', 100));
    clip.dispatchEvent(pointer('pointermove', 140));
    clip.dispatchEvent(pointer('pointerup', 140));
    clip.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(clicked, 'the click that ends a pan is not a tap on the picture').not.toHaveBeenCalled();

    clip.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(clicked, 'the next click is an ordinary one').toHaveBeenCalledTimes(1);
  });
});
