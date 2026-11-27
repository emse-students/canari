// @vitest-environment happy-dom
/**
 * LE PIC AND THE MINER'S LAMP (owner, 2026-11-27): one drawing each. Pinned: Le Pic is named for a screen
 * reader, shows exactly the arms of its pose and the face of its mood, and scales with its size; the lamp
 * burns a flame only when lit. Neither draws a hex colour: every fill is a `--color-pic-*` token.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import LePic from './LePic.svelte';
import MinerLamp from './MinerLamp.svelte';

const mounted: Array<() => void> = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

function show(component: typeof LePic | typeof MinerLamp, props: Record<string, unknown>) {
  document.body.innerHTML = '';
  const app = mount(component as typeof LePic, { target: document.body, props });
  mounted.push(() => unmount(app, { outro: false }));
  flushSync();
  return document.querySelector('svg')!;
}

/** The parts of a pose carry an opacity: a part is "on" when it is 1. */
const visible = (svg: SVGElement) =>
  [...svg.querySelectorAll('[opacity]')].filter((el) => el.getAttribute('opacity') === '1').length;

describe('LePic', () => {
  it('is an image with a name, and scales on the drawing ratio', () => {
    const svg = show(LePic, { size: 110 });
    expect(svg.getAttribute('role')).toBe('img');
    expect(svg.getAttribute('aria-label')).toContain('Le Pic');
    expect(svg.getAttribute('width')).toBe('110');
    expect(svg.getAttribute('height')).toBe('120');
  });

  it('shows one pose at a time', () => {
    const rest = visible(show(LePic, { pose: 'rest', mood: 'neutral' }));
    const point = visible(show(LePic, { pose: 'point', mood: 'neutral' }));
    const flag = visible(show(LePic, { pose: 'flag', mood: 'neutral' }));
    // rest: the second arm (3 parts); point: the raised arm (4); flag: the pole, the flag and its arm (6).
    expect([rest, point, flag]).toEqual([3, 4, 6]);
    expect(show(LePic, { pose: 'flag' }).getAttribute('data-pose')).toBe('flag');
  });

  it('changes the face with the mood, and opens the mouth only when surprised', () => {
    const face = (mood: string) => {
      const svg = show(LePic, { mood });
      return {
        paths: [...svg.querySelectorAll('path')].map((p) => p.getAttribute('d')).join('|'),
        wow: svg.querySelector('ellipse[rx="4.5"][ry="5.5"]')?.getAttribute('opacity'),
      };
    };
    const happy = face('happy');
    const worried = face('worried');
    const surprised = face('surprised');
    expect(happy.paths).not.toBe(worried.paths);
    expect(happy.wow).toBe('0');
    expect(surprised.wow).toBe('1');
  });

  it('draws no raw colour: fills and strokes are the fixed pic tokens', () => {
    const svg = show(LePic, {});
    expect(svg.outerHTML).not.toMatch(/(fill|stroke)="#/);
    expect(svg.outerHTML).toContain('--color-pic-tunic');
  });
});

describe('MinerLamp', () => {
  it('burns a flame only when lit', () => {
    const flameOpacity = (svg: SVGElement) =>
      [...svg.querySelectorAll('path[style*="pic-flame"]')].map((p) => p.getAttribute('opacity'));
    const lit = show(MinerLamp, { lit: true });
    expect(lit.getAttribute('data-lit')).toBe('true');
    expect(flameOpacity(lit)).toEqual(['1', '1']);
    expect(lit.querySelector('rect[style*="glass-lit"]')).not.toBeNull();
    const unlit = show(MinerLamp, { lit: false });
    expect(unlit.getAttribute('data-lit')).toBe('false');
    expect(flameOpacity(unlit)).toEqual(['0', '0']);
    expect(unlit.querySelector('rect[style*="glass-lit"]')).toBeNull();
  });

  it('is decorative: the button that wears it carries the label', () => {
    expect(show(MinerLamp, {}).getAttribute('aria-hidden')).toBe('true');
  });
});
