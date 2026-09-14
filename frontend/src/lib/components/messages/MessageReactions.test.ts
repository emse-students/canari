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
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mount, unmount } from 'svelte';
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
function renderReactions(count: number): HTMLElement {
  const groupedReactions: Record<string, string[]> = {};
  for (let i = 0; i < count; i++) {
    // One codepoint per key, from a block that is entirely emoji, so every key is distinct.
    groupedReactions[String.fromCodePoint(0x1f600 + i)] = [`u${i}`];
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
  it('draws one chip per distinct emoji, at a count that used to be cut off', () => {
    const row = renderReactions(37);
    expect(row.querySelectorAll('button')).toHaveLength(37);
  });

  it('draws them all at a modest count too', () => {
    const row = renderReactions(3);
    expect(row.querySelectorAll('button')).toHaveLength(3);
  });

  it('does not clip: the row has neither a height cap nor a hidden overflow', () => {
    const row = renderReactions(37);
    const cls = row.getAttribute('class') ?? '';
    // `max-h-[5.5rem]` plus `overflow-hidden` is exactly what destroyed sixteen chips.
    expect(cls).not.toMatch(/\bmax-h-/);
    expect(cls).not.toMatch(/\boverflow-hidden\b/);
  });
});
