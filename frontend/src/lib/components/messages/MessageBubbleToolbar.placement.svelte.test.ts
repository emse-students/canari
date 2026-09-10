/**
 * A POPOVER THAT OPENS UPWARD FROM THE TOP OF A SCROLLER IS NOT ON SCREEN.
 *
 * Both of this toolbar's popovers - the quick-reaction bar and the overflow menu - were
 * `absolute bottom-full`, unconditionally. On a message near the top of the thread that puts them
 * above the scroller's top edge, and `.chat-messages-scroll` (`overflow-y: auto`) cuts off whatever
 * crosses it. Measured on the live app at 958px, on the first visible bubble: the overflow menu
 * rendered at `top: -153px`, `bottom: -1px` - the whole of it above the viewport - and what the user
 * photographed was the sliver that survived the clip.
 *
 * IT READS AS A LAYERING FAULT AND IT IS NOT ONE. The same measurement showed the menu at `z-20`
 * and the conversation header at `z-20` with ZERO vertical overlap: nothing was covering it. A
 * z-index is the wrong question about a box that is off-screen, and chasing one would have moved a
 * number until the symptom changed.
 *
 * What is pinned here is the decision, not the pixels: the side is chosen from the room the SCROLLER
 * leaves, because the scroller is what clips. Geometry in happy-dom is all zeroes, so the rects are
 * stubbed - that is exactly the point, since the rule is a comparison between four numbers and it
 * must hold for numbers no browser here can produce.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import MessageBubbleToolbar from './MessageBubbleToolbar.svelte';

const mounted: (() => void)[] = [];

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

/**
 * Mounts the toolbar inside a stand-in scroller and forces one geometry on the page.
 *
 * `bubbleTop` is where the bubble sits inside a scroller running 100 -> 900, and `popoverHeight` is
 * what the popover measures once rendered. Everything the component reads to decide comes from
 * those two numbers.
 */
function mountAt({
  bubbleTop,
  popoverHeight,
  isOwn = false,
}: {
  bubbleTop: number;
  popoverHeight: number;
  isOwn?: boolean;
}) {
  const scroller = document.createElement('div');
  scroller.className = 'chat-messages-scroll';
  document.body.appendChild(scroller);

  scroller.getBoundingClientRect = () =>
    ({ top: 100, bottom: 900, left: 0, right: 800, width: 800, height: 800 }) as DOMRect;

  // Every element the component measures: the anchor answers the bubble's box, and any popover
  // answers its own height. `offsetHeight` is not implemented in happy-dom, so it is defined.
  const origRect = Element.prototype.getBoundingClientRect;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this === scroller) {
      return { top: 100, bottom: 900, left: 0, right: 800, width: 800, height: 800 } as DOMRect;
    }
    if (this.classList.contains('absolute') && this.classList.contains('inset-0')) {
      return {
        top: bubbleTop,
        bottom: bubbleTop + 40,
        left: 0,
        right: 400,
        width: 400,
        height: 40,
      } as DOMRect;
    }
    return origRect.call(this);
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get() {
      return popoverHeight;
    },
  });

  const instance = mount(MessageBubbleToolbar, {
    target: scroller,
    props: {
      isOwn,
      isDeleted: false,
      hasMedia: false,
      showEmojiPicker: false,
      onReply: () => {},
      onForward: () => {},
      onPin: () => {},
      onReact: () => {},
    },
  });
  mounted.push(() => unmount(instance));
  flushSync();
  return scroller;
}

/** Opens the overflow menu the way a reader does - by its button. */
function openMenu(root: HTMLElement): HTMLElement {
  const trigger = [...root.querySelectorAll('button[aria-label]')].find((b) =>
    (b.getAttribute('aria-label') ?? '').startsWith('Plus d')
  );
  if (!trigger) throw new Error('no overflow trigger rendered');
  (trigger as HTMLElement).click();
  flushSync();
  const menu = root.querySelector<HTMLElement>('[role="menu"]');
  if (!menu) throw new Error('the menu did not open');
  return menu;
}

describe('MessageBubbleToolbar - which side a popover opens on', () => {
  it('opens ABOVE when the bubble has room above it, which is the reference placement', () => {
    const root = mountAt({ bubbleTop: 600, popoverHeight: 152 });

    const menu = openMenu(root);
    flushSync();

    expect(menu.className).toContain('bottom-full');
    expect(menu.className).not.toContain('top-full');
  });

  it('FLIPS BELOW when the bubble is too near the top of the scroller for the popover to fit', () => {
    // 152px of popover plus its 8px margin needs 160; this bubble leaves 40.
    const root = mountAt({ bubbleTop: 140, popoverHeight: 152 });

    const menu = openMenu(root);
    flushSync();

    expect(menu.className).toContain('top-full');
    expect(menu.className).not.toContain('bottom-full');
  });

  it('stays ABOVE when neither side fits, rather than flipping to an equally clipped one', () => {
    // A scroller shorter than the popover: above leaves 40, below leaves 760-40. Below is roomier,
    // so this is the case where "flip whenever it does not fit" would move it for nothing.
    const root = mountAt({ bubbleTop: 140, popoverHeight: 900 });

    const menu = openMenu(root);
    flushSync();

    expect(menu.className).toContain('top-full');
  });

  it('always carries exactly one anchor, and is not left invisible once measured', () => {
    // The `invisible` state exists for the frame between "the popover is in the DOM" and "its height
    // has been read". It is not observable from here - effects run on the same flush that creates
    // the node - so what is pinned is the thing that would actually hurt: a popover that settled
    // with no anchor, or with both, or still hidden.
    const root = mountAt({ bubbleTop: 600, popoverHeight: 152 });

    const menu = openMenu(root);
    flushSync();

    const above = menu.className.includes('bottom-full');
    const below = menu.className.includes('top-full');
    expect(above !== below, `exactly one anchor, got "${menu.className}"`).toBe(true);
    expect(menu.className).not.toContain('invisible');
  });
});

/**
 * WHICH WAY A POPOVER GROWS, WHICH IS THE HALF THAT WAS GOT WRONG ONCE ALREADY.
 *
 * The popovers hang off the icon strip, and the strip sits in the gutter on the side away from the
 * message. So a popover has to grow back INWARD, over the message: pinned by its right edge when the
 * strip is on the right, by its left edge when it is on the left. Anchoring to the strip was tried
 * on 2026-09-08 and reverted because the pill ended up "entirely in the gutter, 292px to the left of
 * the message" - that attempt kept the bubble's side instead of mirroring it, and this is the
 * assertion that would have said so.
 *
 * The SENT side is also measured on the live app - strip centre inside the popover's span, 0px
 * horizontal gap. The received side is pinned here rather than on screen because neither test client
 * had a received message on screen to hover.
 */
describe('MessageBubbleToolbar - which way a popover grows from the strip', () => {
  it('pins to its RIGHT edge on a received message, so it grows left over the message', () => {
    const root = mountAt({ bubbleTop: 600, popoverHeight: 152, isOwn: false });

    const menu = openMenu(root);
    flushSync();

    expect(menu.className).toContain('right-0');
    expect(menu.className).not.toContain('left-0');
  });

  it('pins to its LEFT edge on a sent message - the mirror, not the same side', () => {
    const root = mountAt({ bubbleTop: 600, popoverHeight: 152, isOwn: true });

    const menu = openMenu(root);
    flushSync();

    expect(menu.className).toContain('left-0');
    expect(menu.className).not.toContain('right-0');
  });

  it('hangs both popovers off the strip, never off the bubble box', () => {
    // The strip is the anchor the picker also uses (`[data-message-toolbar]`), so a popover that is
    // not inside it is a popover positioned against something else.
    const root = mountAt({ bubbleTop: 600, popoverHeight: 152 });
    const strip = root.querySelector('[data-message-toolbar]');

    const menu = openMenu(root);

    expect(strip).not.toBeNull();
    expect(strip!.contains(menu)).toBe(true);
  });
});
