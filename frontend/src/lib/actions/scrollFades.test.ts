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
