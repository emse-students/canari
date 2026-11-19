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
    expect(rule).toContain(
      'bottom: var(--keyboard-leaf-occlusion-bottom, var(--keyboard-occlusion-bottom'
    );
    expect(rule).not.toMatch(/transition/);
  });

  /**
   * The leaf channel (keyboard-and-send-motion.md, section 6): every keyboard term of the sheet reads
   * the twin the announcement writes on it first, so the ride's first frame needs no whole-document
   * style pass - and its comment thread is never restyled, the twins not being inherited.
   */
  it('reads every keyboard term through the leaf channel, on the sheet itself', () => {
    const source = readFileSync('src/lib/components/shared/CommentsDrawer.svelte', 'utf8');
    const sheet = source.match(/<div[^>]*data-comments-drawer-sheet[^>]*>/)?.[0] ?? '';
    expect(sheet).toContain('data-keyboard-leaf');
    // No keyboard term left in the sheet's utilities, where no twin is read.
    expect(sheet).not.toMatch(/--keyboard-occlusion-bottom|--safe-area-inset-bottom/);
    const css = readFileSync('src/app.css', 'utf8');
    const rule = css.match(/\.keyboard-aware-bottom\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toMatch(
      /max-height:[^;]*var\(--keyboard-leaf-occlusion-bottom, var\(--keyboard-occlusion-bottom/
    );
    expect(rule).toMatch(
      /padding-bottom: var\(--keyboard-leaf-safe-area-inset-bottom, var\(--safe-area-inset-bottom/
    );
  });
});
