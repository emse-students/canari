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
import { describe, it, expect, afterEach } from 'vitest';
import { createRawSnippet, flushSync, mount, unmount } from 'svelte';
import MediaLightbox from './MediaLightbox.svelte';

const mounted: (() => void)[] = [];

const content = createRawSnippet(() => ({
  render: () =>
    '<div><div data-video-player id="player"><video></video></div><div id="picture">x</div></div>',
}));

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

function open(): void {
  const instance = mount(MediaLightbox, {
    target: document.body,
    props: { open: true, onClose: () => {}, children: content },
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
