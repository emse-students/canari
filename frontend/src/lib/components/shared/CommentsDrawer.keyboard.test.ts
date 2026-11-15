import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * The comments drawer stands on the keyboard and RIDES it (#3556, N4). Measured on the Mi 9T before:
 * it was not a riding piece, so it jumped to its new place 68 ms after the announcement on a rise and
 * 138 ms on a fall, while the thread and the composer moved with the keys. `.keyboard-aware-bottom`
 * also carried a 180 ms `ease` transition on `bottom` - overridden by the sheet's inline
 * `transition: none`, and a clock of its own that could only disagree with the keyboard's.
 */
describe('CommentsDrawer and the keyboard', () => {
  it('marks its sheet as a piece that rides the keyboard', () => {
    const source = readFileSync('src/lib/components/shared/CommentsDrawer.svelte', 'utf8');
    const sheet = source.match(/<div[^>]*data-comments-drawer-sheet[^>]*>/)?.[0] ?? '';
    expect(sheet).toContain('data-keyboard-ride="box"');
    expect(sheet).toContain('keyboard-aware-bottom');
  });

  it('gives .keyboard-aware-bottom no transition of its own', () => {
    const css = readFileSync('src/app.css', 'utf8');
    const rule = css.match(/\.keyboard-aware-bottom\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toContain('bottom: var(--keyboard-occlusion-bottom');
    expect(rule).not.toMatch(/transition/);
  });
});
