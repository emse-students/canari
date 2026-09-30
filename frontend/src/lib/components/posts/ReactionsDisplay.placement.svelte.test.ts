/**
 * THE "WHO REACTED" PANEL HAD THREE FAULTS AND THEY ARE ONE WIRING QUESTION.
 *
 * Reported by the user on 2026-09-18: *"ca sort de l'ecran et si on scrolle, le panneau ne
 * disparait pas (et ne suit pas le scroll)"*. Off-screen, stranded by a scroll, and undismissable -
 * all three because the component read the badge's rect ONCE and wrote those viewport coordinates
 * into a `fixed` element itself, and closed only on a `mouseleave` a finger never sends.
 *
 * The clamping and the flip are `fixedPopover`'s and are tested on their own numbers next door.
 * What is pinned HERE is that this panel is wired to them - that it writes no coordinates of its
 * own, that it re-places on a scroll instead of staying behind, and that it closes by three routes
 * a touch screen can actually produce.
 *
 * Geometry in happy-dom is all zeroes, and a zero rect is exactly what `bindFixedPopover` refuses to
 * position against, so the badge's box is stubbed. The numbers are A1's (Mi 9T, 436 x 945 CSS px,
 * 2026-09-14) with the badge at the card's RIGHT edge, which is the case that ran off the screen.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import ReactionsDisplay from './ReactionsDisplay.svelte';

/** A pointer event of the given kind; happy-dom's own PointerEvent is skipped by Svelte's handlers. */
const pointer = (type: string, pointerType: string) =>
  Object.assign(new Event(type, { bubbles: type !== 'pointerenter' }), { pointerType });

vi.mock('$lib/utils/users/displayName', () => ({
  resolveUserDisplayName: (id: string) => Promise.resolve(id === 'u1' ? 'Camille' : null),
  getUserDisplayNameSync: (id: string) => id,
}));

const SCREEN_W = 436;
const SCREEN_H = 945;
/** A badge hugging the card's right edge - 40 px wide, ending 12 px from the screen. */
const BADGE = { left: 384, right: 424, top: 300, bottom: 328, width: 40, height: 28 };

const mounted: (() => void)[] = [];

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

/** Async so the `reactorsTrigger` action has attached before the first event. */
async function render(onReactionClick: (t: string) => void = () => {}) {
  Object.defineProperty(window, 'innerWidth', { value: SCREEN_W, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: SCREEN_H, configurable: true });

  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(ReactionsDisplay, {
    target,
    props: {
      reactionCounts: { like: 2 },
      reactions: { u1: 'like', u2: 'like' },
      userReaction: null,
      reactionList: [{ type: 'like', emoji: '👍' }],
      onReactionClick,
    },
  });
  mounted.push(() => unmount(app, { outro: false }));

  const badge = target.querySelector('button')!;
  badge.getBoundingClientRect = () => ({ ...BADGE, x: BADGE.left, y: BADGE.top, toJSON: () => {} });
  await Promise.resolve();
  return { target, badge };
}

/** The portalled panel, which lives on `document.body` rather than under the component. */
const panel = () => document.querySelector<HTMLElement>('[role="tooltip"]');

function hover(badge: HTMLElement) {
  badge.dispatchEvent(pointer('pointerenter', 'mouse'));
  flushSync();
  // The panel has its own box once open; without it the placement refuses and warns.
  const p = panel();
  if (p) p.getBoundingClientRect = () => ({ ...BADGE, x: 0, y: 0, toJSON: () => {} });
  return p;
}

describe('ReactionsDisplay - the "who reacted" panel', () => {
  it('opens on the badge and is portalled out of the card', async () => {
    const { target, badge } = await render();
    expect(panel()).toBeNull();
    const p = hover(badge);
    expect(p).not.toBeNull();
    expect(target.contains(p!)).toBe(false);
  });

  /**
   * THE COMPONENT MUST NOT WRITE ITS OWN COORDINATES, which is what made it run off the screen:
   * `left` was the badge's left with nothing clamping it. 384 + a 160 px minimum is 544 on a 436 px
   * screen. The action clamps; the component's job is to not fight it.
   */
  it('leaves placement to the shared action - a clamped left, never the badge’s own', async () => {
    const { badge } = await render();
    const p = hover(badge)!;
    const left = Number.parseFloat(p.style.left);
    expect(Number.isFinite(left)).toBe(true);
    expect(left).toBeLessThan(BADGE.left);
    expect(left).toBeGreaterThanOrEqual(0);
  });

  it('closes on a scroll instead of trailing over unrelated posts', async () => {
    const { badge } = await render();
    expect(hover(badge)).not.toBeNull();
    document.body.dispatchEvent(new Event('scroll', { bubbles: false }));
    flushSync();
    expect(panel()).toBeNull();
  });

  it('does not open on a touch tap, and the tap still toggles the reaction', async () => {
    const onReactionClick = vi.fn();
    const { badge } = await render(onReactionClick);
    badge.dispatchEvent(pointer('pointerenter', 'touch'));
    badge.dispatchEvent(pointer('pointerdown', 'touch'));
    badge.dispatchEvent(pointer('pointerup', 'touch'));
    badge.click();
    flushSync();
    expect(panel()).toBeNull();
    expect(onReactionClick).toHaveBeenCalledWith('like');
  });

  it('opens on a long press and that press does not toggle the reaction', async () => {
    vi.useFakeTimers();
    try {
      const onReactionClick = vi.fn();
      const { badge } = await render(onReactionClick);
      badge.dispatchEvent(pointer('pointerdown', 'touch'));
      vi.advanceTimersByTime(500);
      flushSync();
      expect(panel()).not.toBeNull();
      badge.dispatchEvent(pointer('pointerup', 'touch'));
      badge.click();
      expect(onReactionClick).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * THREE ROUTES OUT, AND `mouseleave` IS THE ONLY ONE THAT USED TO EXIST. A finger never sends it,
   * so the panel a long press opened simply stayed - the third fault in the same report.
   */
  it('closes on a tap outside', async () => {
    const { badge } = await render();
    expect(hover(badge)).not.toBeNull();
    document.body.dispatchEvent(new Event('click', { bubbles: true, composed: true }));
    flushSync();
    expect(panel()).toBeNull();
  });

  it('does NOT close on the tap that opened it, whatever order the events arrive in', async () => {
    const { badge } = await render();
    expect(hover(badge)).not.toBeNull();
    badge.dispatchEvent(new Event('click', { bubbles: true, composed: true }));
    flushSync();
    expect(panel()).not.toBeNull();
  });

  it('closes on Escape', async () => {
    const { badge } = await render();
    expect(hover(badge)).not.toBeNull();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    flushSync();
    expect(panel()).toBeNull();
  });
});
