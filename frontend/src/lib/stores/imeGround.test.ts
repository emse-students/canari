// @vitest-environment happy-dom
import { groundOf } from './imeGround';

/**
 * THE GROUND UNDER THE KEYBOARD'S BAND IS THE SCREEN'S, NOT THE THEME'S (review of #3490, N1): a
 * full-bleed black screen (CanaReels, live, camera) must get black under the band, a conversation its
 * grey, and a glass composer is looked through.
 */
const rgb = (css: string): string | null => {
  const m = /^rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)$/.exec(css);
  if (!m || (m[4] !== undefined && Number(m[4]) !== 1)) return null;
  return `#${[m[1], m[2], m[3]].map((v) => Number(v).toString(16).padStart(2, '0')).join('')}`;
};

function tree(backgrounds: string[]): Element {
  let parent: Element = document.body;
  for (const bg of backgrounds) {
    const el = document.createElement('div');
    el.dataset.bg = bg;
    parent.appendChild(el);
    parent = el;
  }
  return parent;
}
const bgOf = (el: Element) => (el as HTMLElement).dataset?.bg ?? 'rgba(0, 0, 0, 0)';

describe('groundOf', () => {
  it('looks through a translucent glass composer to the page under it', () => {
    const composer = tree(['rgb(240, 242, 245)', 'rgba(255, 255, 255, 0.6)', 'rgba(0, 0, 0, 0)']);
    expect(groundOf(composer, bgOf, rgb)).toBe('#f0f2f5');
  });

  it('takes the black of a full-bleed screen over the theme', () => {
    const reel = tree(['rgb(240, 242, 245)', 'rgb(0, 0, 0)', 'rgba(0, 0, 0, 0)']);
    expect(groundOf(reel, bgOf, rgb)).toBe('#000000');
  });

  it('answers null when nothing is opaque, and for no element', () => {
    expect(groundOf(tree(['rgba(0, 0, 0, 0)']), bgOf, rgb)).toBeNull();
    expect(groundOf(null, bgOf, rgb)).toBeNull();
  });
});
