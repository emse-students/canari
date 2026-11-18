import { describe, expect, it } from 'vitest';
import { withoutAnyComments } from './lib/styles/markupSources';
import { sourceFiles } from './test/sourceTree';

/**
 * EVERY BOTTOM SAFE AREA IS READ THROUGH `--safe-area-inset-bottom` (second review of #3556).
 *
 * `app.css` defines the variable from `env(safe-area-inset-bottom)` - the one place that does - and
 * two writers move it: `app.html` pins it to 0 outside Tauri, and the keyboard store pins it to 0
 * while a keyboard covers the strip (`keyboardSafeAreaBottomOverride`: iOS's stale 34 px, the
 * Android overlay's navigation bar, D2). A component reading `env()` itself skips both: the media
 * viewer's info sheet and the video controls kept the navigation bar's strip under an Android
 * keyboard. Comments are not reads, so they are stripped first (`withoutAnyComments`).
 */
const THE_DEFINITION = 'src/app.css';

describe('the bottom safe area has one reader of env()', () => {
  it('no file but app.css reads env(safe-area-inset-bottom) directly', () => {
    const files = sourceFiles({
      under: 'src',
      extensions: ['ts', 'svelte', 'css', 'html'],
      tests: 'exclude',
    });
    // The scan reads the tree it thinks it does: the definition is in it.
    const definition = files.find((f) => f.path === THE_DEFINITION);
    // The pin's unpinned twin is the one place env() is read (#3569: the overlay pins the public name).
    expect(definition?.text).toContain(
      '--safe-area-inset-bottom-unpinned: env(safe-area-inset-bottom'
    );
    const offenders = files
      .filter((f) => f.path !== THE_DEFINITION)
      .filter((f) => /env\(\s*safe-area-inset-bottom/.test(withoutAnyComments(f.text)))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });
});
