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
 * own - and the gesture decided on 2026-10-01, Discord's: a tap reacts, a hold shows who reacted,
 * for a mouse as for a finger, and the list closes on the reader's next action, whatever it is.
 *
 * Geometry in happy-dom is all zeroes, and a zero rect is exactly what `bindFixedPopover` refuses to
 * position against, so the badge's box is stubbed. The numbers are A1's (Mi 9T, 436 x 945 CSS px,
 * 2026-09-14) with the badge at the card's RIGHT edge, which is the case that ran off the screen.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import ReactionsDisplay from './ReactionsDisplay.svelte';
import { LONG_PRESS_MS } from '$lib/actions/reactorsTrigger';

/** A pointer event of the given kind; happy-dom's own PointerEvent is skipped by Svelte's handlers. */
const pointer = (type: string, pointerType: string) =>
  Object.assign(new Event(type, { bubbles: true }), {
    pointerType,
    button: 0,
    clientX: 0,
    clientY: 0,
  });

vi.mock('$lib/utils/users/displayName', () => ({
  resolveUserDisplayName: (id: string) => Promise.resolve(id === 'u1' ? 'Camille' : null),
  getUserDisplayNameSync: (id: string) => id,
}));

const SCREEN_W = 436;
const SCREEN_H = 945;
/** A badge hugging the card's right edge - 40 px wide, ending 12 px from the screen. */
const BADGE = { left: 384, right: 424, top: 300, bottom: 328, width: 40, height: 28 };

const mounted: (() => void)[] = [];

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
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

/** A hold on the badge, released - the gesture that asks "who reacted" (Discord's, 2026-10-01). */
function hold(badge: HTMLElement, pointerType = 'touch') {
  badge.dispatchEvent(pointer('pointerdown', pointerType));
  vi.advanceTimersByTime(LONG_PRESS_MS + 50);
  flushSync();
  badge.dispatchEvent(pointer('pointerup', pointerType));
  badge.click();
  flushSync();
  // The panel has its own box once open; without it the placement refuses and warns.
  const p = panel();
  if (p) p.getBoundingClientRect = () => ({ ...BADGE, x: 0, y: 0, toJSON: () => {} });
  return p;
}

describe('ReactionsDisplay - the "who reacted" panel', () => {
  it('opens on a hold and is portalled out of the card', async () => {
    const { target, badge } = await render();
    expect(panel()).toBeNull();
    const p = hold(badge);
    expect(p).not.toBeNull();
    expect(target.contains(p!)).toBe(false);
  });

  it('names the reactors on hover instead of naming the reaction type', async () => {
    const { badge } = await render();

    expect(badge.getAttribute('title')).toBe('Camille, u2');
    expect(badge.getAttribute('title')).not.toBe('like');
  });

  /**
   * THE COMPONENT MUST NOT WRITE ITS OWN COORDINATES, which is what made it run off the screen:
   * `left` was the badge's left with nothing clamping it. 384 + a 160 px minimum is 544 on a 436 px
   * screen. The action clamps; the component's job is to not fight it.
   */
  it('leaves placement to the shared action - a clamped left, never the badge’s own', async () => {
    const { badge } = await render();
    const p = hold(badge)!;
    const left = Number.parseFloat(p.style.left);
    expect(Number.isFinite(left)).toBe(true);
    expect(left).toBeLessThan(BADGE.left);
    expect(left).toBeGreaterThanOrEqual(0);
  });

  /**
   * A TAP REACTS AND NOTHING ELSE - the defect of 2026-10-01: a mouse opened the list on HOVER, on
   * its way to every click, so reacting and asking "who" were the same gesture.
   */
  it.each(['mouse', 'touch'])('a %s tap toggles the reaction and opens no list', async (kind) => {
    const onReactionClick = vi.fn();
    const { badge } = await render(onReactionClick);
    badge.dispatchEvent(pointer('pointerenter', kind));
    badge.dispatchEvent(pointer('pointerdown', kind));
    vi.advanceTimersByTime(100);
    badge.dispatchEvent(pointer('pointerup', kind));
    badge.click();
    flushSync();
    expect(panel()).toBeNull();
    expect(onReactionClick).toHaveBeenCalledWith('like');
  });

  it('opens on nothing but a hold - a mouse resting on the badge opens no list', async () => {
    const { badge } = await render();
    badge.dispatchEvent(pointer('pointerenter', 'mouse'));
    vi.advanceTimersByTime(2000);
    flushSync();
    expect(panel()).toBeNull();
  });

  it.each(['mouse', 'touch'])('a %s hold opens the list and does not react', async (kind) => {
    const onReactionClick = vi.fn();
    const { badge } = await render(onReactionClick);
    expect(hold(badge, kind)).not.toBeNull();
    expect(onReactionClick).not.toHaveBeenCalled();
  });

  it('stays open once the hold that opened it is released', async () => {
    const { badge } = await render();
    hold(badge);
    expect(panel()).not.toBeNull();
  });

  /**
   * IT CLOSES ON THE READER'S NEXT ACTION, WHATEVER IT IS (user, 2026-10-01: *"des la prochaine
   * action (scroll etc.)"*) - a press anywhere, the badge and the list included, a scroll, the
   * wheel, a key.
   */
  it.each([
    ['a press elsewhere', () => document.body.dispatchEvent(pointer('pointerdown', 'touch'))],
    ['a press on the list itself', () => panel()!.dispatchEvent(pointer('pointerdown', 'touch'))],
    ['a scroll of an inner list', () => document.body.dispatchEvent(new Event('scroll'))],
    ['the wheel', () => window.dispatchEvent(new Event('wheel'))],
    ['a key', () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))],
  ])('closes on %s', async (_, act) => {
    const { badge } = await render();
    expect(hold(badge)).not.toBeNull();
    act();
    flushSync();
    expect(panel()).toBeNull();
  });

  it('closes on a press on its own badge, and that press is a tap like any other', async () => {
    const onReactionClick = vi.fn();
    const { badge } = await render(onReactionClick);
    hold(badge);
    badge.dispatchEvent(pointer('pointerdown', 'touch'));
    flushSync();
    expect(panel()).toBeNull();
    badge.dispatchEvent(pointer('pointerup', 'touch'));
    badge.click();
    expect(onReactionClick).toHaveBeenCalledWith('like');
  });
});
