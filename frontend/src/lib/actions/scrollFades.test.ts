// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { scrollFades } from './scrollFades';

/** jsdom lays nothing out, so the scroll geometry is set by hand. */
function row(scrollWidth: number, clientWidth: number, scrollLeft = 0) {
  const node = document.createElement('div');
  Object.defineProperty(node, 'scrollWidth', { value: scrollWidth, configurable: true });
  Object.defineProperty(node, 'clientWidth', { value: clientWidth, configurable: true });
  Object.defineProperty(node, 'scrollLeft', {
    value: scrollLeft,
    writable: true,
    configurable: true,
  });
  document.body.appendChild(node);
  return node;
}

describe('scrollFades - a row that scrolls says so', () => {
  it('fades nothing when the row fits', () => {
    const node = row(300, 300);
    scrollFades(node);
    expect(node.hasAttribute('data-fade-start')).toBe(false);
    expect(node.hasAttribute('data-fade-end')).toBe(false);
  });

  it('fades only the end at the start of an overflowing row', () => {
    const node = row(480, 390);
    scrollFades(node);
    expect(node.hasAttribute('data-fade-start')).toBe(false);
    expect(node.hasAttribute('data-fade-end')).toBe(true);
  });

  it('fades both edges in the middle, and only the start at the end', () => {
    const node = row(480, 390);
    scrollFades(node);
    node.scrollLeft = 40;
    node.dispatchEvent(new Event('scroll'));
    expect(node.hasAttribute('data-fade-start')).toBe(true);
    expect(node.hasAttribute('data-fade-end')).toBe(true);
    node.scrollLeft = 90;
    node.dispatchEvent(new Event('scroll'));
    expect(node.hasAttribute('data-fade-start')).toBe(true);
    expect(node.hasAttribute('data-fade-end')).toBe(false);
  });
});

describe('scrollFades - children rendered after the action started', () => {
  it('observes a chip added later, and stops on destroy', async () => {
    const watched = new Set<Element>();
    const stub = class {
      observe(el: Element) {
        watched.add(el);
      }
      unobserve(el: Element) {
        watched.delete(el);
      }
      disconnect() {}
    };
    const prior = globalThis.ResizeObserver;
    globalThis.ResizeObserver = stub as unknown as typeof ResizeObserver;
    try {
      const node = row(300, 300);
      const action = scrollFades(node);
      const chip = document.createElement('button');
      node.append(chip);
      await Promise.resolve();
      expect(watched.has(chip)).toBe(true);
      action.destroy();
      const later = document.createElement('button');
      node.append(later);
      await Promise.resolve();
      expect(watched.has(later)).toBe(false);
    } finally {
      globalThis.ResizeObserver = prior;
    }
  });
});
