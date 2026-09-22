/**
 * PANNING A ZOOMED PICTURE WITH A MOUSE WAS IMPOSSIBLE, BECAUSE THE BROWSER TOOK THE GESTURE FIRST.
 *
 * An `<img>` is `draggable` by DEFAULT. Press on one and move, and the browser starts a
 * drag-and-drop of the picture: it paints the translucent ghost a reader reads as "it selected the
 * image" (user, 2026-09-22: *"on ne puisse pas se deplacer dans la visionneuse (le fait de tenter de
 * drag l'image la selectionne)"*) and it stops delivering pointer moves. `handlePointerMove` never
 * runs, so `panTo` never runs, so nothing moves - on every image in the app, since the lightbox is
 * the one viewer behind `PostMedia`, `PostContent`, `MessageMediaRenderer`,
 * `ConversationMediaPanel` and `ChatComposer`.
 *
 * `select-none` on the transform wrapper does NOT cover it. Measured in a live engine on
 * 2026-09-22: an `<img>` inside a `user-select: none` container computes `user-select: none` and
 * still fires an uncancelled `dragstart`. Text selection and the native image drag are two
 * different gestures, and only one of them was refused.
 *
 * THE REFUSAL IS ON THE WRAPPER, NOT ON THE IMAGE. The content is `{@render children}`: five call
 * sites pass their own markup, and `draggable="false"` spelt in each of them is a rule one of them
 * will eventually not spell. The wrapper already owns the zoom, the pan and the dismiss drag - it
 * owns their competitor too, for whatever a call site renders inside it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createRawSnippet, flushSync, mount, unmount } from 'svelte';
import MediaLightbox from './MediaLightbox.svelte';

const mounted: (() => void)[] = [];

/** One picture, which is what every call site ends up passing. */
const picture = createRawSnippet(() => ({
  render: () => '<img alt="" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" />',
}));

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

function openLightbox(): void {
  const instance = mount(MediaLightbox, {
    target: document.body,
    props: { open: true, onClose: () => {}, children: picture },
  });
  mounted.push(() => unmount(instance));
  flushSync();
}

/** The image the reader presses on, wherever the portal put it. */
function image(): HTMLImageElement {
  const found = document.querySelector('img');
  if (!found) throw new Error('no image rendered');
  return found as HTMLImageElement;
}

describe('MediaLightbox - the browser does not get to drag the picture away', () => {
  it('cancels a dragstart raised on the image it is showing', () => {
    openLightbox();
    const event = new Event('dragstart', { bubbles: true, cancelable: true });
    image().dispatchEvent(event);
    expect(event.defaultPrevented, 'the native image drag is refused').toBe(true);
  });

  it('refuses it from the wrapper, so any content a call site renders is covered', () => {
    openLightbox();
    // A second child, standing for whatever else a call site may put in the viewer - a video
    // poster, a figure, a wrapper of its own. It carries no handler and needs none.
    const other = document.createElement('div');
    image().parentElement?.appendChild(other);
    const event = new Event('dragstart', { bubbles: true, cancelable: true });
    other.dispatchEvent(event);
    expect(event.defaultPrevented, 'the refusal is inherited by every child').toBe(true);
  });
});
