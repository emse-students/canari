// @vitest-environment happy-dom
/**
 * THE GLASS GLYPH HAS NO DISC AND KEEPS ITS TOUCH TARGET (owner, 2026-11-09: *"J'aurais juste fait le
 * triangle en liquid glass"*).
 *
 * Pinned: the glass layer is clipped to the shape (not a circle) and decorative; the play button's
 * invisible square is at least 44 px (64, 72 on a reel) while the glyph draws no chip; the blur and
 * its fallbacks are the video glass's own variables, so reduced transparency, more contrast and a
 * missing `backdrop-filter` flatten the triangle to a solid dark tint with its rim; the pause shows
 * as bars. WHETHER WEBKIT BLURS THROUGH A CLIPPED SHAPE IS NOT PINNED HERE - nothing in a test can.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { flushSync, mount, unmount, type Component } from 'svelte';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import VideoGlassGlyph from './VideoGlassGlyph.svelte';
import VideoPlayGlyph from './VideoPlayGlyph.svelte';

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

function render<P extends Record<string, any>>(
  component: Component<P>,
  props: NoInfer<P>
): HTMLElement {
  const instance = mount(component, { target: document.body, props });
  mounted.push(() => unmount(instance));
  flushSync();
  return document.body;
}

describe('VideoGlassGlyph', () => {
  it('clips the glass to the shape and is decorative', () => {
    const body = render(VideoGlassGlyph, { kind: 'play', size: 64 });
    const glass = body.querySelector<HTMLElement>('.glass-video-shape')!;
    expect(glass.getAttribute('style')).toMatch(/clip-path:\s*path\('M/);
    expect(glass.className).not.toContain('rounded');
    expect(body.querySelector('[data-video-glass-glyph]')!.getAttribute('aria-hidden')).toBe(
      'true'
    );
  });

  it('draws the pause as two bars, with a rim and a shadow beside the glass', () => {
    const body = render(VideoGlassGlyph, { kind: 'pause', size: 64 });
    const paths = [...body.querySelectorAll('svg path')].map((p) => p.getAttribute('d')!);
    expect(paths).toHaveLength(2);
    expect(paths[0]).toBe(paths[1]);
    expect(paths[0].match(/M/g)).toHaveLength(2);
    // The shadow is a SIBLING of the glass: a filter on an ancestor would blur nothing behind it.
    const glass = body.querySelector('.glass-video-shape')!;
    expect(glass.querySelector('svg')).toBeNull();
    expect(glass.closest('[style*="filter"]')).toBeNull();
  });

  it('gives each glyph its own rim gradient', () => {
    const body = render(VideoGlassGlyph, { kind: 'play', size: 64 });
    render(VideoGlassGlyph, { kind: 'play', size: 64 });
    const ids = [...body.querySelectorAll('linearGradient')].map((g) => g.id);
    expect(new Set(ids).size).toBe(2);
  });
});

describe('VideoPlayGlyph', () => {
  it.each([
    ['md', 64],
    ['lg', 72],
  ] as const)('keeps a %s hit target of at least 44 px around the triangle', (size, px) => {
    const body = render(VideoPlayGlyph, { onclick: () => {}, size });
    const button = body.querySelector<HTMLElement>('button')!;
    expect(button.style.width).toBe(`${px}px`);
    expect(button.style.height).toBe(`${px}px`);
    expect(px).toBeGreaterThanOrEqual(44);
    expect(button.className).not.toMatch(/glass-video|rounded-full|bg-/);
  });
});

describe('the glass of a glyph in the stylesheet', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/app.css'), 'utf8');

  it('uses the video glass variables, so every fallback that flattens the chip flattens it', () => {
    const rule = /\.glass-video-shape \{([^}]*)\}/.exec(css)![1];
    expect(rule).toContain('var(--glass-video-bg)');
    expect(rule).toContain('var(--glass-video-blur)');
    // The three fallbacks set these variables on the root: reduced transparency, more contrast and a
    // missing backdrop-filter.
    const flatSets = css.match(/--glass-video-bg: var\(--glass-video-flat-bg\);/g) ?? [];
    expect(flatSets.length).toBeGreaterThanOrEqual(4);
  });

  it('draws no border and no box shadow: a clipped element cannot carry them', () => {
    const rule = /\.glass-video-shape \{([^}]*)\}/.exec(css)![1];
    expect(rule).not.toMatch(/border|box-shadow/);
  });
});
