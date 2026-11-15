// @vitest-environment happy-dom
/**
 * THE LAYOUT HOOKS, DRIVEN BY A SEQUENCE OF NAVIGATIONS (review of #3648): feed scrolled, a link to an
 * association, the arrow, the Back that returns, the offset that comes back with it - and the second
 * feed entry that keeps ITS OWN offset. `+layout.svelte` calls `onLeavingEntry` from `beforeNavigate`
 * and `onArrivedAtEntry` from `afterNavigate` and nothing else, so this is its wiring.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const route = vi.hoisted(() => ({ url: new URL('http://x/') }));
vi.mock('$app/state', () => ({ page: route }));
vi.mock('$lib/utils/historyOverlayStack', () => ({ historyOverlayStackDepth: () => 0 }));

import { backDecision } from './backToOrigin';
import { HISTORY_METADATA_KEY, currentEntryKey, memoryOf, resetEntryMemory } from './historyEntry';
import { onArrivedAtEntry, onLeavingEntry } from './navigationMemory';
import { cancelRestore } from './scrollMemory';

afterEach(() => {
  cancelRestore();
  resetEntryMemory();
  document.body.innerHTML = '';
});

function box(scroll = 9000) {
  const el = document.createElement('div');
  Object.defineProperty(el, 'scrollHeight', { value: scroll });
  Object.defineProperty(el, 'clientHeight', { value: 800 });
  document.body.appendChild(el);
  return el;
}

/** One navigation as SvelteKit lives it: `beforeNavigate` on the old entry, then the new state, then `afterNavigate`. */
function navigate(
  type: 'link' | 'goto' | 'popstate' | 'enter',
  key: number,
  from: string | null,
  to: string,
  scroller: HTMLElement,
  shallow = false
) {
  const n = {
    type,
    shallow,
    from: from ? { url: new URL(`http://x${from}`) } : null,
    to: { url: new URL(`http://x${to}`) },
  };
  onLeavingEntry(n, scroller.scrollTop);
  history.replaceState({ [HISTORY_METADATA_KEY]: { navigationIndex: key } }, '');
  route.url = new URL(`http://x${to}`);
  onArrivedAtEntry(n, scroller);
}

describe('feed -> association -> arrow -> feed, at the same offset', () => {
  it('records the origin, decides history, and restores the feed on the popstate', () => {
    const scroller = box();
    navigate('enter', 10, null, '/posts', scroller);
    scroller.scrollTop = 1200;
    navigate('link', 11, '/posts', '/associations/bde', scroller);
    scroller.scrollTop = 0;

    expect(memoryOf(11)?.from).toBe('/posts');
    expect(
      backDecision('/associations/bde', memoryOf(currentEntryKey())?.from, '/associations')
    ).toBe('history');

    navigate('popstate', 10, '/associations/bde', '/posts', scroller);
    expect(scroller.scrollTop).toBe(1200);
  });

  it('two feed entries keep two offsets (the key is the entry, not the address)', () => {
    const scroller = box();
    navigate('enter', 1, null, '/posts', scroller);
    scroller.scrollTop = 400;
    navigate('link', 2, '/posts', '/lists/a', scroller);
    navigate('link', 3, '/lists/a', '/posts', scroller);
    scroller.scrollTop = 2500;
    navigate('link', 4, '/posts', '/lists/b', scroller);
    scroller.scrollTop = 0;

    navigate('popstate', 3, '/lists/b', '/posts', scroller);
    expect(scroller.scrollTop).toBe(2500);
    navigate('popstate', 2, '/posts', '/lists/a', scroller);
    scroller.scrollTop = 0;
    navigate('popstate', 1, '/lists/a', '/posts', scroller);
    expect(scroller.scrollTop).toBe(400);
  });

  it('a link opens a page at its top: the offset comes back on a popstate only', () => {
    const scroller = box();
    navigate('enter', 1, null, '/posts', scroller);
    scroller.scrollTop = 1200;
    navigate('link', 2, '/posts', '/associations/bde', scroller);
    scroller.scrollTop = 0;
    navigate('link', 3, '/associations/bde', '/posts', scroller);
    expect(scroller.scrollTop).toBe(0);
  });
});

describe('a shallow navigation of ANY type is not a page the memory is about', () => {
  it.each(['goto', 'link', 'popstate'] as const)('%s', (type) => {
    const scroller = box();
    navigate('enter', 1, null, '/posts', scroller);
    scroller.scrollTop = 900;
    navigate(type, 2, '/posts', '/posts?tab=b', scroller, true);
    expect(currentEntryKey()).toBe(1);
    expect(memoryOf(1)?.top).toBeUndefined();
    expect(memoryOf(2)).toBeUndefined();
  });
});

describe('the layout calls these hooks and nothing else of the memory', () => {
  it('wires both, for every non-shallow navigation', () => {
    const layout = readFileSync(resolve(__dirname, '../../routes/+layout.svelte'), 'utf8');
    expect(layout).toContain('onLeavingEntry({ type, shallow, from, to }');
    expect(layout).toContain('onArrivedAtEntry(nav, pageScrollWrap)');
    // The memory hooks run for every navigation (they skip shallow ones themselves), and the old
    // shallow-goto early return still guards the overlay drain and the rest, so a shallow POPSTATE
    // keeps draining the overlay stack as before.
    const before = layout.slice(layout.indexOf('beforeNavigate(('));
    expect(before.indexOf('onLeavingEntry(')).toBeLessThan(
      before.indexOf("if (shallow && type === 'goto') return;")
    );
    expect(before.indexOf("if (shallow && type === 'goto') return;")).toBeLessThan(
      before.indexOf('drainHistoryOverlayStack()')
    );
  });
});
