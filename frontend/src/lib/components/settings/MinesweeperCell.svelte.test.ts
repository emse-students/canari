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
   * The engine here resolves the custom property through the cascade but leaves `calc()` standing
   * (`calc(180ms * 0.5)`), so the one product it leaves is evaluated; any other shape is a failure.
   */
  function milliseconds(computed: string): number {
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
