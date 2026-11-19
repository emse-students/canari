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
import { describe, it, expect } from 'vitest';
import source from './MinesweeperCell.svelte?raw';

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
