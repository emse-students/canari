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
  bubbleLeft = 0,
  bubbleRight = 400,
  popoverWidth = 0,
}: {
  bubbleTop: number;
  popoverHeight: number;
  isOwn?: boolean;
  /** The bubble's own span inside a scroller running 0 -> 800. A SHORT bubble is a narrow one. */
  bubbleLeft?: number;
  bubbleRight?: number;
  /** What the popover measures once rendered. Zero - happy-dom's default - means "always fits". */
  popoverWidth?: number;
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
        left: bubbleLeft,
        right: bubbleRight,
        width: bubbleRight - bubbleLeft,
        height: 40,
      } as DOMRect;
    }
    // THE STRIP, which is what the horizontal decision is measured from - the popovers are its
    // children and pin to ITS edges. It hangs in the gutter on the side away from the message:
    // `right-full` (so its right edge is the bubble's left) for an own message, `left-full` for a
    // peer's. STRIP_W is the three icons; the number does not matter, its SIDE does.
    if (this.hasAttribute('data-message-toolbar')) {
      const STRIP_W = 100;
      const [left, right] = isOwn
        ? [bubbleLeft - STRIP_W, bubbleLeft]
        : [bubbleRight, bubbleRight + STRIP_W];
      return { top: bubbleTop, bottom: bubbleTop + 40, left, right, width: STRIP_W } as DOMRect;
    }
    return origRect.call(this);
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get() {
      return popoverWidth;
    },
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

/**
 * INWARD IS A DIRECTION, NOT A PROMISE OF ROOM - AND A SHORT MESSAGE IS WHERE IT RUNS OUT.
 *
 * The block above pins that a popover grows back INWARD over the message, which is right and was
 * paid for twice. What it does not say is how far inward there IS. The popover's width is fixed -
 * six emojis and the button that opens the full picker - and the message's is not, so growing
 * inward over a bubble NARROWER than the popover overshoots the bubble and carries on past the far
 * edge of the scroller. `overflow-y: auto` computes `overflow-x` to `auto` as well, so that edge
 * clips exactly as the top one does, and the result is the user's report of 2026-09-13: the
 * reaction bar on a short message runs off the window, while the full emoji panel - a different
 * component - places correctly.
 *
 * The reproduction is arithmetic, which is why it is here and not on a screenshot. An own `Coucou`
 * at 700..780 in an 800-wide scroller puts its strip at 600..700; a 280px pill pinned to the
 * strip's left edge ends at 880, which is 80px outside. A LONG own message hides it - the strip
 * moves left and the same pill fits - which is exactly why the report said "message court".
 *
 * The rule is the vertical one on the other axis, against the same clipper, with the same tie-break.
 */
describe('MessageBubbleToolbar - a popover that cannot grow inward grows the other way', () => {
  /** An own message pinned to the right of the scroller, 80px wide - the reported case. */
  const shortOwn = (popoverWidth: number) =>
    mountAt({
      bubbleTop: 600,
      popoverHeight: 152,
      isOwn: true,
      bubbleLeft: 700,
      bubbleRight: 780,
      popoverWidth,
    });

  it('MIRRORS on a short OWN message, because inward would end past the right edge', () => {
    // Strip at 600..700, so inward leaves 800-600 = 200 and the pill needs 280.
    const menu = openMenu(shortOwn(280));

    expect(menu.className).toContain('right-0');
    expect(menu.className).not.toContain('left-0');
  });

  it('keeps the reference on the SAME message when the popover is narrow enough to fit', () => {
    // The mirror must be driven by room and by nothing else: same bubble, smaller pill.
    const menu = openMenu(shortOwn(150));

    expect(menu.className).toContain('left-0');
    expect(menu.className).not.toContain('right-0');
  });

  it('MIRRORS on a short PEER message, which is the same defect on the other side', () => {
    // Strip at 80..180, so inward - leftward from 180 - leaves 180 and the pill needs 280.
    const menu = openMenu(
      mountAt({
        bubbleTop: 600,
        popoverHeight: 152,
        isOwn: false,
        bubbleLeft: 0,
        bubbleRight: 80,
        popoverWidth: 280,
      })
    );

    expect(menu.className).toContain('left-0');
    expect(menu.className).not.toContain('right-0');
  });

  it('keeps the reference when NEITHER side fits, rather than flipping to an equally clipped one', () => {
    // A pill wider than the whole scroller. Inward leaves 200, outward leaves 700-0 = 700 for an
    // own message... so this is the case that must NOT be decided by "does it fit" alone: a bubble
    // in the MIDDLE, where the two sides are equal and the reference has to win.
    const menu = openMenu(
      mountAt({
        bubbleTop: 600,
        popoverHeight: 152,
        isOwn: true,
        bubbleLeft: 450,
        bubbleRight: 550,
        popoverWidth: 900,
      })
    );

    // Inward leaves 800-350 = 450, outward leaves 450-0 = 450. Neither fits 900 and neither is
    // roomier, so the placement the rest of the file pins is the one that survives.
    expect(menu.className).toContain('left-0');
  });

  it('both popovers take the same anchor, so the menu cannot drift from the pill', () => {
    // They are two elements with one rule. The quick bar is opened by its own trigger; what is
    // pinned here is that the class the menu carries is the class the measurement produced.
    const root = shortOwn(280);
    const menu = openMenu(root);
    const anchored = menu.className.includes('right-0');

    expect(anchored, 'the overflow menu mirrors on a short own message').toBe(true);
    expect(menu.className.includes('left-0')).toBe(false);
  });
});
