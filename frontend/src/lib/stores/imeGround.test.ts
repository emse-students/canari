// @vitest-environment happy-dom
import { vi } from 'vitest';
import { cssColorToHex, groundOf } from './imeGround';

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

/**
 * A canvas whose `fillStyle` IGNORES an unparsable value, as every engine's does, so the previous
 * value survives the assignment - the property the probe's resting colour exists for.
 */
function fakeCanvas(): HTMLCanvasElement {
  const pixels: Record<string, [number, number, number, number]> = {
    'rgba(0, 0, 0, 0)': [0, 0, 0, 0],
    red: [255, 0, 0, 255],
  };
  let fill = '#000000';
  let painted: [number, number, number, number] = [0, 0, 0, 0];
  const ctx = {
    get fillStyle() {
      return fill;
    },
    set fillStyle(value: string) {
      if (value in pixels) fill = value;
    },
    clearRect: () => {
      painted = [0, 0, 0, 0];
    },
    fillRect: () => {
      painted = pixels[fill] ?? [0, 0, 0, 255];
    },
    getImageData: () => ({ data: painted }),
  };
  return { width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement;
}

describe('cssColorToHex', () => {
  it('reads an unparsable colour as null, never as the colour converted before it', () => {
    const create = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) =>
      tag === 'canvas' ? fakeCanvas() : create(tag)
    );
    expect(cssColorToHex('red')).toBe('#ff0000');
    expect(cssColorToHex('not-a-colour')).toBeNull();
    expect(cssColorToHex('red')).toBe('#ff0000');
    vi.restoreAllMocks();
  });
});
