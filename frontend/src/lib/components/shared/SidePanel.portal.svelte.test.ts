/**
 * A DRAWER THAT STAYS INSIDE THE PAGE IS LAID OUT AGAINST THE PAGE, NOT THE WINDOW.
 *
 * `.page-scroll-wrap` carries `will-change: transform` for the swipe-between-tabs gesture. That one
 * declaration makes it BOTH a stacking context and the containing block for every `position: fixed`
 * inside it, which `app.css` states where the layer ladder is declared and closes with the rule this
 * gate enforces: anything that must escape a page entirely has to be PORTALLED to the body.
 *
 * So a panel written in a page is laid out against `<main>` - between the header and the bottom bar
 * rather than over them - and painted under both however high its rung is, because its rung is only
 * compared with its siblings inside that wrapper.
 *
 * WHY NOTHING CAUGHT IT FOR A YEAR: the conversation panels open on a screen that hides
 * `MobileHeader` and `BottomNav`, so there the content area IS the viewport and the containing block
 * coincides with it. The community settings open from the conversation LIST, where both are on
 * screen - and their foot, which is where the leave and delete buttons are, sat under the bottom bar.
 * The `Modal` they replaced never had the problem, because `Modal` portals.
 *
 * THE COLUMN IS THE OPPOSITE CASE AND IT IS PINNED TOO. At `xl` a chat panel is `position: static`,
 * a flex SIBLING of the other cards, and a node moved to `<body>` has no row left to join. So the
 * rule is not "portal panels" - it is that the two shapes want opposite things, which is why one
 * boolean decides both and why both directions are asserted here. A regression in either direction
 * is silent: nothing about the markup looks wrong, and happy-dom reports no geometry to contradict
 * it, so the PARENT is what this reads.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createRawSnippet, flushSync, mount, unmount } from 'svelte';
import SidePanel from './SidePanel.svelte';

const mounted: (() => void)[] = [];

/** A body for the panel. Its content is irrelevant here - only where the shell around it lands is. */
const body = createRawSnippet(() => ({ render: () => '<p>reglages</p>' }));

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

/**
 * Mounts a panel inside a stand-in for the page wrapper and returns that wrapper.
 *
 * The wrapper stands for `.page-scroll-wrap`: what matters is only that it is an element BETWEEN the
 * panel and `<body>`, since the question is which of the two ends up as the node's parent.
 */
function mountInPage(column: boolean): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'page-scroll-wrap';
  document.body.appendChild(wrap);

  const instance = mount(SidePanel, {
    target: wrap,
    props: { open: true, title: 'Parametres', onClose: () => {}, column, children: body },
  });
  mounted.push(() => unmount(instance));
  flushSync();
  return wrap;
}

/** The panel element itself, wherever it ended up. */
function panel(): HTMLElement {
  const found = document.querySelector('aside.side-panel');
  if (!found) throw new Error('no side panel rendered');
  return found as HTMLElement;
}

/** The scrim, which has to travel with the panel or it dims the page under it instead of over it. */
function scrim(): HTMLElement {
  const found = document.querySelector('button[class*="inset-0"]');
  if (!found) throw new Error('no scrim rendered');
  return found as HTMLElement;
}

describe('a side panel leaves the page unless it has a row to join', () => {
  it('portals a drawer out to the body, so the window is what positions it', () => {
    const wrap = mountInPage(false);

    expect(panel().parentElement).toBe(document.body);
    expect(wrap.contains(panel())).toBe(false);
  });

  it('takes the scrim with it - a scrim left behind dims the page under the panel', () => {
    const wrap = mountInPage(false);

    expect(scrim().parentElement).toBe(document.body);
    expect(wrap.contains(scrim())).toBe(false);
  });

  it('leaves a column where it was written, because a portalled node has no row to join', () => {
    const wrap = mountInPage(true);

    expect(wrap.contains(panel())).toBe(true);
    expect(panel().parentElement).not.toBe(document.body);
  });

  it('marks the column with the class its 1280px rule is written against', () => {
    // The two halves have to agree: `column` decides both the portal above and this class, and a
    // panel that portalled AND claimed the column would be `position: static` inside `<body>`.
    mountInPage(true);
    expect(panel().classList.contains('side-panel-column')).toBe(true);

    while (mounted.length) mounted.pop()!();
    document.body.innerHTML = '';

    mountInPage(false);
    expect(panel().classList.contains('side-panel-column')).toBe(false);
  });
});
