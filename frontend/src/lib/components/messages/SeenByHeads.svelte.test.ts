/**
 * THE "SEEN BY" HEADS: three at most, then `+N` (user, 2026-10-02). Where each head is anchored is
 * `seenByAnchors`' job and is pinned in `readState.test.ts`; this file pins only the drawing, which
 * the DM receipt and the group placement share.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import SeenByHeads from './SeenByHeads.svelte';

vi.mock('$lib/utils/users/displayName', () => ({
  getUserDisplayNameSync: (id: string) => id,
  resolveUserDisplayName: (id: string) => Promise.resolve(id),
}));

vi.mock('$lib/utils/userAvatarCache', () => ({
  resolveUserAvatarDisplayUrl: async () => ({ kind: 'none' as const }),
  releaseUserAvatarDisplayUrl: () => {},
}));

const mounted: (() => void)[] = [];

afterEach(() => {
  while (mounted.length) mounted.pop()?.();
  document.body.innerHTML = '';
});

function render(readers: string[], withCheck = false): HTMLElement {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(SeenByHeads, { target, props: { readers, withCheck } });
  flushSync();
  mounted.push(() => unmount(component));
  return target;
}

describe('SeenByHeads', () => {
  it('draws every head up to three, and no counter', () => {
    const el = render(['a', 'b', 'c']);
    const heads = el.querySelector('[aria-hidden="true"]');

    expect(heads?.children.length).toBe(3);
    expect(el.textContent).not.toContain('+');
  });

  it('folds everyone past the third head into "+N"', () => {
    const el = render(['a', 'b', 'c', 'd', 'e']);
    const heads = el.querySelector('[aria-hidden="true"]');

    // Three avatars and the counter.
    expect(heads?.children.length).toBe(4);
    expect(heads?.lastElementChild?.textContent).toBe('+2');
  });

  it('names every reader to assistive technology, since the heads are hidden from it', () => {
    const el = render(['a', 'b', 'c', 'd']);

    expect(el.querySelector('[role="status"]')).not.toBeNull();
    expect(el.querySelector('.sr-only')?.textContent).toMatch(/a, b, c, d/);
  });

  it('names the readers folded into "+N" on the counter itself', () => {
    const el = render(['a', 'b', 'c', 'd', 'e']);
    const counter = el.querySelector('[aria-hidden="true"]')?.lastElementChild;

    expect(counter?.getAttribute('title')).toBe('d, e');
  });
});
