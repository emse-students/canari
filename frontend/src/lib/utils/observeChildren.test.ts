// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { observeChildren } from './observeChildren';

/** A ResizeObserver that only remembers what it is watching. */
function fakeObserver() {
  const watched = new Set<Element>();
  const observer = {
    observe: (el: Element) => watched.add(el),
    unobserve: (el: Element) => watched.delete(el),
  } as unknown as ResizeObserver;
  return { observer, watched };
}

const flush = () => Promise.resolve();

describe('observeChildren', () => {
  it('watches the children that exist now', () => {
    const node = document.createElement('div');
    node.append(document.createElement('i'), document.createElement('b'));
    const { observer, watched } = fakeObserver();
    observeChildren(node, observer);
    expect(watched.size).toBe(2);
  });

  it('watches a child rendered AFTER it started, and releases one that left', async () => {
    const node = document.createElement('div');
    const { observer, watched } = fakeObserver();
    observeChildren(node, observer);
    expect(watched.size).toBe(0);
    const a = document.createElement('i');
    node.append(a);
    await flush();
    expect(watched.has(a)).toBe(true);
    a.remove();
    await flush();
    expect(watched.has(a)).toBe(false);
  });

  it('watches only the children the selector names', async () => {
    const node = document.createElement('div');
    const { observer, watched } = fakeObserver();
    observeChildren(node, observer, '[data-tab]');
    const tab = document.createElement('button');
    tab.setAttribute('data-tab', '');
    node.append(tab, document.createElement('span'));
    await flush();
    expect([...watched]).toEqual([tab]);
  });

  it('stops following the child list once stopped, and does nothing without an observer', async () => {
    const node = document.createElement('div');
    const { observer, watched } = fakeObserver();
    const stop = observeChildren(node, observer);
    stop();
    node.append(document.createElement('i'));
    await flush();
    expect(watched.size).toBe(0);
    expect(() => observeChildren(node, null)()).not.toThrow();
  });
});
