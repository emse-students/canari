/**
 * A MINIMISED CALL'S BAR IS ABOVE EVERY LAYER THAT COVERS THE SCREEN (CALL-BAR-COVERED, 2026-10-19).
 *
 * Read on the Mi 9T and the iPhone: with the new-post composer or its camera open, the call bar was
 * under that layer - `elementFromPoint` at its hang-up returned the camera's video - so the call
 * could not be ended until the layer closed. The bar is a row of the banner column (`--z-banner`,
 * 120) and those layers sit at 280-320.
 *
 * The rule (calls.md, "The bar is never under a layer"): while a call bar is up, the column takes
 * `--z-call`, and every covering surface pushes its top inset below the column. This file holds the
 * three halves that a later edit could undo without any other test noticing: the ORDER (no rung a
 * covering surface uses may reach `--z-call`), the CSS that applies it, and the inset every top
 * control reads.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { svelteFiles, withoutComments } from './markupSources';

const src = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// A Windows checkout reads CRLF, and every pattern below is written in LF.
const css = readFileSync(join(src, 'app.css'), 'utf8').replace(/\r\n/g, '\n');
// THE TREE IS READ ONCE, HERE, AND NOT INSIDE A TEST. Reading every `.svelte` file is the slow part
// of this file, and a test body is charged against vitest's 5 s timeout: under the full suite, with
// every worker reading the disk at once, two bodies that each walked the tree timed out while
// asserting nothing wrong. Module scope is collection time, which no per-test timeout measures.
const markup = svelteFiles(src).map((path) => ({
  path,
  text: withoutComments(readFileSync(path, 'utf8')),
}));

const rung = (name: string): number => {
  const match = css.match(new RegExp(`--z-${name}:\\s*(\\d+);`));
  expect(match, `--z-${name} is a rung of the ladder`).not.toBeNull();
  return Number(match![1]);
};

/** The rungs a covering surface can take: every rung named in a file that uses `coversScreen`. */
function coveringRungs(): { file: string; name: string }[] {
  const out: { file: string; name: string }[] = [];
  for (const { path, text } of markup) {
    if (!text.includes('use:coversScreen')) continue;
    for (const match of text.matchAll(/--z-([a-z-]+)/g)) {
      out.push({ file: relative(src, path).replace(/\\/g, '/'), name: match[1] });
    }
  }
  return out;
}

describe('the call bar and the layers that cover the screen', () => {
  it('every rung a covering surface uses is below --z-call, the one the bar takes', () => {
    const call = rung('call');
    const found = coveringRungs();
    // Modals, viewers, sheets and confirmations are all here; the camera is a viewer.
    expect(found.map((f) => f.name)).toEqual(
      expect.arrayContaining(['modal', 'viewer', 'critical'])
    );
    const above = found.filter((f) => f.name !== 'call' && rung(f.name) >= call);
    expect(above, 'a covering surface at or above the call bar would hide its hang-up').toEqual([]);
    // The two covering classes positioned in app.css rather than in markup.
    expect(rung('side-panel')).toBeLessThan(call);
    expect(rung('sheet')).toBeLessThan(call);
  });

  it('lifts the banner column to --z-call while a call bar is up', () => {
    expect(css).toMatch(
      /:root\[data-call-bar\] \.app-banner-column \{\s*z-index: var\(--z-call\);\s*\}/
    );
    const layout = readFileSync(join(src, 'routes', '+layout.svelte'), 'utf8');
    expect(layout).toMatch(/bind:this=\{bannerColumn\} class="app-banner-column /);
  });

  it('pushes every covering surface top inset below the column, resolved on the root', () => {
    expect(css).toMatch(
      /:root \{\s*--app-cover-top: calc\(var\(--safe-area-inset-top, 0px\) \+ var\(--app-banner-height, 0px\)\);\s*\}/
    );
    expect(css).toMatch(
      /:root\[data-call-bar\] \[data-covers-screen\] \{\s*--safe-area-inset-top: var\(--app-cover-top\);\s*\}/
    );
  });

  it('gives the camera tab its status-bar padding back while a call bar is up', () => {
    expect(css).toMatch(
      /:root\.fullscreen-place-open\[data-call-bar\] \.app-shell \{\s*padding-top: var\(--safe-area-inset-top, 0px\);\s*\}/
    );
  });

  it('no component reads the top inset from env() - that one would not move below the bar', () => {
    const readers = markup
      .filter(({ text }) => /env\(safe-area-inset-top/.test(text))
      .map(({ path }) => relative(src, path).replace(/\\/g, '/'));
    expect(readers).toEqual([]);
  });
});
