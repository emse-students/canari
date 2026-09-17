/**
 * WHERE IS THE SHEET'S OVERLAY WHEN THE SHEET MEASURES IT?
 *
 * `MessageMobileActions` lifts the thread so the sheet does not cover the message it acts on, and
 * the number that decides the lift comes from `overlay.getBoundingClientRect().bottom` - where
 * `overlay` is `sheet.parentElement`, which IS the `use:portal` div. So the read is taken on a node
 * that another action moves to `<body>`, and the ONE effect before that move is a window in which
 * the answer is about `.page-scroll-wrap` rather than the window.
 *
 * THE COMPILER SAYS THE MEASUREMENT IS QUEUED FIRST, AND THE MEASUREMENT SAYS IT IS NOT.
 * `$.user_effect` for the script's `$effect` is emitted before `$.action(div, portal)`, and effects
 * run in creation order - which is an argument, not a reading. The effect early-returns while
 * `sheetEl` is unset, and `bind:this` inside the `{#if}` assigns in a later pass, so in fact every
 * read of the overlay lands AFTER the move. The site is correct today.
 *
 * SO IT IS CORRECT BY A SEQUENCE RATHER THAN BY A RULE, WHICH IS WHY IT IS PINNED. Nothing in the
 * component says the read must follow the move; it follows it because of where a `bind:this` writes.
 * Reordering the effect, hoisting the ref, or giving the sheet its own `{#if}` would each move the
 * read back into the window without looking like a change to this file.
 *
 * WHAT IT WOULD COST is invisible on the screen the sheet opens on: that screen hides
 * `MobileHeader` and `BottomNav`, so the wrapper fills the viewport and both answers coincide - the
 * same coincidence that hid the side-panel defect until a panel opened from the conversation LIST.
 *
 * This records the overlay's PARENT at the instant of each read. happy-dom reports no geometry,
 * which does not matter: the question is parentage, and parentage is what decides whether the
 * geometry would have been right.
 *
 * THE LIMIT OF THE SWEEP THIS CAME FROM, so nobody reads it as more than it is: the population is
 * `$lib/actions/portal`'s consumers, thirteen components, and each was read for
 * `getBoundingClientRect`, `offsetTop`, `offsetParent`, `scrollIntoView` and `.focus(`. Four of the
 * five that read a position read a node that never moves. A read taken by some OTHER component on a
 * portalled node would not have been seen - no component here exposes such a reference, every one
 * being local, but that is a fact about today's code rather than a property the sweep established.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import MessageMobileActions from './MessageMobileActions.svelte';

const mounted: (() => void)[] = [];

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

/** Every element whose rect was read, paired with where it sat at that instant. */
type Read = { tag: string; className: string; parentTag: string | null; inBody: boolean };

/**
 * Builds the page the sheet really opens in and mounts the sheet inside it.
 *
 * The wrapper stands for `.page-scroll-wrap` and the scroller for `.chat-messages-scroll`, which
 * the effect looks up with `closest()` from the bubble - without it the effect returns before it
 * measures anything, and the test would assert about a path that never ran.
 */
function openSheetInAPage(): { reads: Read[]; overlay: () => HTMLElement | null } {
  const wrap = document.createElement('div');
  wrap.className = 'page-scroll-wrap';
  const scroller = document.createElement('div');
  scroller.className = 'chat-messages-scroll';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  scroller.appendChild(bubble);
  wrap.appendChild(scroller);
  document.body.appendChild(wrap);

  const reads: Read[] = [];
  const original = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    reads.push({
      tag: this.tagName,
      className: this.className,
      parentTag: this.parentElement?.tagName ?? null,
      inBody: this.parentElement === document.body,
    });
    return original.call(this);
  };

  const instance = mount(MessageMobileActions, {
    target: wrap,
    props: { visible: true, anchor: bubble },
  });
  mounted.push(() => {
    Element.prototype.getBoundingClientRect = original;
    unmount(instance);
  });
  flushSync();
  Element.prototype.getBoundingClientRect = original;

  return {
    reads,
    overlay: () => document.querySelector<HTMLElement>('div.fixed.inset-0'),
  };
}

describe('the sheet measures its overlay', () => {
  it('portals the overlay to the body, which is the layout this reads against', () => {
    const { overlay } = openSheetInAPage();
    expect(overlay()?.parentElement).toBe(document.body);
  });

  it('never reads the overlay while it is still inside the page', () => {
    const { reads } = openSheetInAPage();

    // The overlay is the only `fixed inset-0` node this component draws. Any read of it taken while
    // its parent is not `<body>` is a rect measured against `.page-scroll-wrap`.
    const overlayReads = reads.filter((r) => r.className.includes('inset-0'));

    // A GATE NOTHING REACHES IS AN ABSENCE THAT LOOKS LIKE ONE. If the effect never measured the
    // overlay, the assertion below holds vacuously and would keep holding after the defect landed.
    expect(
      overlayReads.length,
      `the effect never measured the overlay, so this asserts nothing - reads seen: ` +
        JSON.stringify(reads)
    ).toBeGreaterThan(0);
    const early = overlayReads.filter((r) => !r.inBody);

    expect(
      early,
      `the overlay's rect was read ${early.length} time(s) before the portal moved it, ` +
        `so the lift was computed against ${early.map((r) => r.parentTag).join(', ')} rather than the window`
    ).toEqual([]);
  });
});
