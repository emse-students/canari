// @vitest-environment happy-dom
/**
 * THE INFO PANEL NAMES ITS READERS ONLY WHEN IT IS SHOWN, AND ONCE PER READER. Every bubble mounts
 * this tooltip, hidden; its effect used to resolve every reader anyway and to re-run once per name
 * it wrote, re-resolving every reader each time - 2.4 s of CPU on a 60-reader salon open on the
 * Mi 9T (docs/wiki/frontend/community-open-slowness-mi9t-2026-10-13.md, finding 3).
 */
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import MessageInfoTooltip from './MessageInfoTooltip.svelte';
import { flushMacrotask } from '../../../test/flush';

const calls = vi.hoisted(() => ({ sync: 0, resolve: 0 }));

vi.mock('$lib/utils/users/displayName', () => ({
  getUserDisplayNameSync: (id: string) => {
    calls.sync++;
    return id;
  },
  getUserFirstNameSync: (_id: string, fallback: string) => fallback,
  // Each name answers on its own macrotask, as the network does: one answer, one write.
  resolveUserDisplayName: (id: string) => {
    calls.resolve++;
    return flushMacrotask().then(() => `Name ${id}`);
  },
}));

// The panel's `in:fly` is a Web Animation that happy-dom rejects with an AbortError when the test
// unmounts mid-flight; the transition is not what this file pins.
vi.mock('svelte/transition', () => ({ fly: () => ({ duration: 0 }) }));

const mounted: (() => void)[] = [];

beforeEach(() => {
  calls.sync = 0;
  calls.resolve = 0;
});

afterEach(() => {
  while (mounted.length) mounted.pop()?.();
  document.body.innerHTML = '';
});

const READERS = Array.from({ length: 60 }, (_, i) => `user-${i}`);

function render(visible: boolean) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const props = $state({ visible, timestamp: new Date(0), readBy: READERS });
  const component = mount(MessageInfoTooltip, { target, props });
  flushSync();
  mounted.push(() => unmount(component));
  return { target, props };
}

/** Lets every pending name answer land and every effect it scheduled run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await flushMacrotask();
    flushSync();
  }
}

describe('MessageInfoTooltip', () => {
  it('resolves no name while the panel is hidden', async () => {
    render(false);
    await settle();

    expect(calls.sync).toBe(0);
    expect(calls.resolve).toBe(0);
  });

  it('resolves each reader exactly once when the panel opens, not once per name written', async () => {
    const { target, props } = render(false);
    props.visible = true;
    flushSync();
    await settle();

    expect(calls.resolve).toBe(READERS.length);
    expect(calls.sync).toBe(READERS.length);
    expect(target.textContent).toContain('Name user-0');
    expect(target.textContent).toContain('Name user-59');
  });
});
