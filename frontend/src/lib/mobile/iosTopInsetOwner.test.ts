import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sourceFiles } from '../../test/sourceTree';

/**
 * THE iPHONE'S TOP INSET HAS ONE OWNER (docs/wiki/frontend/android-ios-parity.md#11).
 *
 * Bench iPhone 12, 1.7.0-alpha.12, 2026-11-18: a white band of 47 pt above the header. The status bar
 * was counted twice - once by UIKit, which insets the WKWebView's scroll view until it is told
 * `.never`, and once by the page, padded by `--safe-area-inset-top`. The safe-area hook published the
 * page's half at LAUNCH, and UIKit's half was only withdrawn at `didBecomeActive`, so a launch that did
 * not become active at once kept both. Nothing compiles `canari_ios.mm` on a workstation and the
 * defect is silent, so the order is pinned here:
 *
 * 1. the publisher withdraws UIKit's inset BEFORE it measures, and nothing else does;
 * 2. the withdrawal is idempotent and clamps the offset the switch strands (it fires no KVO);
 * 3. the number the page is told subtracts whatever the scroll view still insets, so publishing
 *    twice, before or after activation, writes the same value;
 * 4. the page's variable is SET by native and written by no page code, so a repeated event cannot add.
 */
const here = dirname(fileURLToPath(import.meta.url));
const iosMm = readFileSync(
  resolve(here, '../../../src-tauri/gen/apple/Sources/canari/canari_ios.mm'),
  'utf8'
);

/** The body of `static void <name>(...)`, from its opening brace to the brace closing it. */
function body(name: string): string {
  const start = iosMm.search(new RegExp(`\\nstatic void ${name}\\([^)]*\\) \\{`));
  expect(start, `${name} is defined`).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = iosMm.indexOf('{', start); i < iosMm.length; i++) {
    if (iosMm[i] === '{') depth++;
    if (iosMm[i] === '}' && --depth === 0) return iosMm.slice(start, i + 1);
  }
  throw new Error(`${name} has no closing brace`);
}

describe('iOS top inset: one owner (anti-regression)', () => {
  it('withdraws UIKit inset inside the publisher, before any measure', () => {
    const publish = body('CanariPublishSafeAreaInsets');
    const apply = publish.indexOf('CanariApplyEdgeToEdge(webView);');
    expect(apply).toBeGreaterThan(-1);
    for (const measure of ['webView.window', 'window.safeAreaInsets', 'evaluateJavaScript']) {
      expect(publish.indexOf(measure), measure).toBeGreaterThan(apply);
    }
  });

  it('is withdrawn nowhere else, so no path can publish before it', () => {
    const calls = [...iosMm.matchAll(/CanariApplyEdgeToEdge\(([^)]*)\);/g)].map((m) => m[1]);
    expect(calls).toEqual(['webView']);
    expect(iosMm.match(/contentInsetAdjustmentBehavior = UIScrollView/g)).toHaveLength(1);
  });

  it('switches once and puts the stranded offset back', () => {
    const apply = body('CanariApplyEdgeToEdge');
    expect(apply).toMatch(
      /if \(scrollView\.contentInsetAdjustmentBehavior == UIScrollViewContentInsetAdjustmentNever\) \{\s*return;\s*\}/
    );
    expect(apply.indexOf('CanariClampDocumentScroll(scrollView);')).toBeGreaterThan(
      apply.indexOf('= UIScrollViewContentInsetAdjustmentNever;')
    );
  });

  it('tells the page only what UIKit has not given, so the same event twice gives the same top', () => {
    const publish = body('CanariPublishSafeAreaInsets');
    expect(publish).toContain('webView.scrollView.adjustedContentInset.top');
    expect(publish).toMatch(
      /CGFloat top =\s*MAX\(0\.0, window\.safeAreaInsets\.top - MAX\(0\.0, CGRectGetMinY\(inWindow\)\) - scrollTop\);/
    );
    expect(publish).toContain(
      "document.documentElement.style.setProperty('--safe-area-inset-top', '%.0fpx');"
    );
  });

  it('leaves the variable to native: no page code writes it', () => {
    const writers = sourceFiles({ under: 'src', extensions: ['ts', 'svelte'], tests: 'exclude' })
      .filter((f) => /setProperty\(\s*['"]--safe-area-inset-top['"]/.test(f.text))
      .map((f) => f.path);
    expect(writers).toEqual([]);
  });
});
