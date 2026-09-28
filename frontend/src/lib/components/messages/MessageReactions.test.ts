/**
 * EVERY REACTION ON A MESSAGE IS DRAWN, AND THE ROW DOES NOT CLIP.
 *
 * This row shipped with `max-h-[5.5rem] overflow-hidden` on a `flex-wrap` container whose height
 * grows with the number of DISTINCT emoji. Measured on A1 (Mi 9T, 436 x 945 CSS px) on 2026-09-14,
 * by cloning chips into the live row over CDP: at 37 distinct reactions the content stood 184px
 * against a box still fixed at 88, so 21 chips were drawn and SIXTEEN were not on screen at all -
 * no half-cut chip to betray the fold, no "+16" overflow chip, and `overflow: hidden` rather than
 * `auto`, so nothing could be scrolled to either. The information was destroyed silently.
 *
 * TWO ASSERTIONS, AND THEY ANSWER DIFFERENT QUESTIONS. That every emoji gets a button is behaviour,
 * and it passed even while the defect shipped - the buttons existed, the box hid them. So the second
 * assertion is about the CONTAINER, and it is deliberately written against the class list: happy-dom
 * resolves no stylesheet and reports no layout, so `getComputedStyle` here cannot tell a clipping
 * box from an open one. Naming the two classes is the only statement this environment can make, and
 * it is the exact statement that would have failed on the shipped version.
 *
 * SINCE 2026-09-28 THE ROW FOLDS, AND SAYS SO: past `VISIBLE_KINDS + 1` kinds it draws the four most
 * chosen and a `+N` chip naming the rest, and a tap on it draws every one - so "every emoji gets a
 * button" is now asserted AFTER the unfold, the only state in which it is the promise.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import MessageReactions from './MessageReactions.svelte';

vi.mock('$lib/utils/users/displayName', () => ({
  getUserDisplayNameSync: (id: string) => `User ${id}`,
  resolveUserDisplayName: async (id: string) => `User ${id}`,
}));

const mounted: (() => void)[] = [];

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

/** Mounts the row with `count` distinct emoji, one reactor each, and returns its container. */
function renderReactions(count: number, reactorsOf: (i: number) => number = () => 1): HTMLElement {
  const groupedReactions: Record<string, string[]> = {};
  for (let i = 0; i < count; i++) {
    // One codepoint per key, from a block that is entirely emoji, so every key is distinct.
    groupedReactions[String.fromCodePoint(0x1f600 + i)] = Array.from(
      { length: reactorsOf(i) },
      (_, n) => `u${i}-${n}`
    );
  }
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(MessageReactions, {
    target,
    props: { groupedReactions, isOwn: false, currentUserId: 'me' },
  });
  mounted.push(() => void unmount(app));
  const row = target.querySelector<HTMLElement>('[role="group"]');
  if (!row) throw new Error('the reactions row did not render');
  return row;
}

describe('MessageReactions', () => {
  it('folds past five kinds into the four most chosen and a +N chip naming the rest', () => {
    // The last three kinds are the most chosen, so ranking - not arrival order - picks what shows.
    const row = renderReactions(8, (i) => (i >= 5 ? 10 - i : 1));
    const buttons = [...row.querySelectorAll('button')];
    expect(buttons).toHaveLength(5);
    expect(buttons.slice(0, 3).map((b) => b.getAttribute('aria-label'))).toEqual([
      expect.stringContaining('5'),
      expect.stringContaining('4'),
      expect.stringContaining('3'),
    ]);
    expect(buttons[4].textContent?.trim()).toBe('+4');
  });

  it('draws one chip per distinct emoji once unfolded, at a count that used to be cut off', async () => {
    const row = renderReactions(37);
    row.querySelector<HTMLButtonElement>('button:last-of-type')!.click();
    await tick();
    expect(row.querySelectorAll('button')).toHaveLength(37);
  });

  it('never folds a single kind: five are drawn whole rather than as four and a +1', () => {
    expect(renderReactions(5).querySelectorAll('button')).toHaveLength(5);
    expect(renderReactions(3).querySelectorAll('button')).toHaveLength(3);
  });

  it('does not clip: the row has neither a height cap nor a hidden overflow', () => {
    const row = renderReactions(37);
    const cls = row.getAttribute('class') ?? '';
    // `max-h-[5.5rem]` plus `overflow-hidden` is exactly what destroyed sixteen chips.
    expect(cls).not.toMatch(/\bmax-h-/);
    expect(cls).not.toMatch(/\boverflow-hidden\b/);
  });
});
