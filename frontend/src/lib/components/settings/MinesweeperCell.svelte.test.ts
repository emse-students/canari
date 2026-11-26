// @vitest-environment happy-dom
/**
 * THE CELL FOLLOWS THE ANIMATION SETTING (owner, 2026-11-18): digging a cell faded it from hidden to
 * revealed whatever the player chose, because every `button` takes a 180 ms colour crossfade from the
 * base layer of app.css and a cell is a button. Pinned: the cell takes that duration from `--ms-anim`
 * (the modal's animation factor), so "none" (0) makes a dig instant and "fast" halves it.
 *
 * Read from the source: the test runner does not inject a component's CSS, so a browser's computed
 * style cannot be asked here. The declaration is static, so the source IS what ships; what a phone
 * paints is the reading owed on the entry for this change.
 */
import { afterEach, describe, it, expect } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import source from './MinesweeperCell.svelte?raw';
import MinesweeperCell from './MinesweeperCell.svelte';
import { animationFactor } from '$lib/minesweeper/settings';

/** The component's own `<style>` block. */
const css = source.slice(source.indexOf('<style>'));

describe('MinesweeperCell transition', () => {
  it('takes the crossfade duration of its button from the animation factor', () => {
    expect(css).toMatch(
      /\bbutton\s*\{[^}]*transition-duration:\s*calc\(180ms \* var\(--ms-anim,\s*1\)\)/
    );
  });

  it("keeps the base layer's duration (180 ms) at the normal speed, so only the setting changes it", () => {
    // 180ms * 1 = the 180 ms app.css gives every button: normal speed is unchanged.
    expect(css).toContain('calc(180ms * var(--ms-anim, 1))');
  });

  it('carries no Tailwind transition utility that would answer for the duration instead', () => {
    // A `transition-*` class on the cell would sit in the utilities layer and could fight the rule above.
    const markup = source.slice(0, source.indexOf('<style>'));
    expect(markup).not.toMatch(/\btransition(-[a-z]+)?\b/);
  });
});

/**
 * THE COMPUTED DURATION, NOT THE RULE (reading `1.7.3-alpha.6`: a 180 ms crossfade cannot be read
 * from a phone snapshot). The component's own `<style>` is injected the way the bundler ships it,
 * the cell is mounted under the element the modal sets `--ms-anim` on, and the browser engine's
 * computed value is asked - so "none" is instant and "fast" is half of 180 ms.
 */
describe('MinesweeperCell computed transition', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const c of cleanups.splice(0)) c();
    document.head.innerHTML = '';
    document.body.innerHTML = '';
  });

  /**
   * An engine may resolve the custom property and leave `calc()` standing (`calc(180ms * 0.5)`, as
   * here) or return a plain length (`0.09s`); both are read, any other shape fails.
   */
  function milliseconds(computed: string): number {
    const plain = /^([\d.]+)(m?)s$/.exec(computed);
    if (plain) return Number(plain[1]) * (plain[2] ? 1 : 1000);
    const m = /^calc\(([\d.]+)ms \* ([\d.]+)\)$/.exec(computed);
    if (!m) throw new Error(`unexpected computed transition-duration: ${computed}`);
    return Number(m[1]) * Number(m[2]);
  }

  function durationAt(speed: Parameters<typeof animationFactor>[0]): number {
    const style = document.createElement('style');
    style.textContent = css.replace(/<\/?style>/g, '');
    document.head.appendChild(style);
    const stage = document.createElement('div');
    stage.style.setProperty('--ms-anim', String(animationFactor(speed)));
    document.body.appendChild(stage);
    const c = mount(MinesweeperCell, {
      target: stage,
      props: {
        cell: { state: 'revealed', mine: false, adjacent: 1 } as never,
        index: 0,
        pending: false,
      },
    });
    cleanups.push(() => void unmount(c));
    flushSync();
    return milliseconds(getComputedStyle(stage.querySelector('button')!).transitionDuration);
  }

  it('is instant on "Aucune" (a dig is not a fade)', () => {
    expect(animationFactor('off')).toBe(0);
    expect(durationAt('off')).toBe(0);
  });

  it('is half as long on "fast", and the base 180 ms at the normal speed', () => {
    expect(durationAt('fast')).toBeCloseTo(90);
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    expect(durationAt('normal')).toBe(180);
  });
});

/**
 * ONE RING PER CELL (review of #4091): a cell both `marked` (the replay's last move) and lit by the
 * bulb shows the bulb's ring only, and a lit cell carries a label a screen reader can hear.
 */
describe('MinesweeperCell highlight', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const c of cleanups.splice(0)) c();
    document.body.innerHTML = '';
  });

  function cellWith(props: {
    marked?: boolean;
    highlight?: 'hint' | 'wrong' | 'read' | 'far' | null;
    state?: 'hidden' | 'revealed';
  }) {
    const app = mount(MinesweeperCell, {
      target: document.body,
      props: {
        cell: { mine: false, adjacent: 2, state: props.state ?? 'revealed' },
        index: 0,
        pending: false,
        marked: props.marked,
        highlight: props.highlight,
      },
    });
    cleanups.push(() => unmount(app));
    flushSync();
    return document.querySelector<HTMLButtonElement>('[data-cell="0"]')!;
  }

  it('lets the hint win over the replay ring, never both', () => {
    const wrong = cellWith({ marked: true, highlight: 'wrong' });
    expect(wrong.className).toContain('ring-red-err');
    expect(wrong.className).not.toContain('ring-accent');
    expect(wrong.className.match(/\bring-2\b/g)).toHaveLength(1);
  });

  it('keeps the replay ring alone when nothing is lit', () => {
    const marked = cellWith({ marked: true });
    expect(marked.className).toContain('ring-accent');
    expect(marked.className).not.toContain('ms-hint');
    expect(marked.getAttribute('aria-label')).toBeNull();
  });

  it('names a lit number and a misplaced flag for a screen reader', () => {
    expect(cellWith({ highlight: 'hint' }).getAttribute('aria-label')).toBe('2, indice');
    document.body.innerHTML = '';
    expect(cellWith({ highlight: 'wrong' }).getAttribute('aria-label')).toBe('Drapeau mal placé');
  });

  it('draws a cell the picture only suggests dotted and faded, with no background', () => {
    const far = cellWith({ highlight: 'far', state: 'hidden' });
    expect(far.className).toContain('border-dashed');
    expect(far.className).toContain('opacity-60');
    expect(far.className).toContain('bg-transparent');
    expect(far.className).not.toContain('ms-hidden');
    expect(far.getAttribute('data-hint')).toBe('far');
  });

  it('rings the number a tutorial step reads in the text colour, so it is never taken for a yellow group', () => {
    const read = cellWith({ highlight: 'read' });
    expect(read.className).toContain('ring-text-main');
    expect(read.className).not.toContain('ring-accent');
    expect(read.className).not.toContain('ms-hint');
    expect(read.getAttribute('data-hint')).toBe('read');
    expect(read.getAttribute('aria-label')).toBe('Chiffre lu : 2');
  });
});
