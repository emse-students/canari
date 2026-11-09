import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { allMarkup, withoutComments } from '$lib/styles/markupSources';

/**
 * THE HEADING TYPE RULE (owner, 2026-11-09): the display face (Fredoka) is for the page title (`h1`),
 * a NAME and the wordmark; `h2..h6` are the body family; no heading is letter-spaced. Nothing else
 * enforces it - a heading is a plain element and a stray `tracking-tight` or an `h2` re-added to the
 * Fredoka rule would compile and look only slightly off.
 */
const ROOT = process.cwd();
const markup = allMarkup(join(ROOT, 'src'));

describe('heading typography', () => {
  it('app.css gives the display face to h1 and the opt-in classes only', () => {
    const css = withoutComments(readFileSync(join(ROOT, 'src/app.css'), 'utf8'));
    const rule = /([^{}]*)\{\s*font-family:\s*var\(--font-display\);\s*\}/.exec(css);
    expect(rule).not.toBeNull();
    const selectors = (rule?.[1] ?? '').split(',').map((s) => s.trim());
    expect(selectors).toEqual(['h1', '.font-brand', '.font-display']);
  });

  it('no heading element is letter-spaced', () => {
    const offenders = markup.flatMap(({ file, body }) => {
      const flat = body.replace(/\s+/g, ' ');
      const hits = [...flat.matchAll(/<h[1-6]\b[^>]*>/g)].filter((m) =>
        /\btracking-(tight|tighter)\b/.test(m[0])
      );
      return hits.map(() => file);
    });
    expect(offenders).toEqual([]);
  });

  it('a settings section card carries no icon tile and no visible heading', () => {
    const sections = markup.filter(({ file }) =>
      /components[/\\]settings[/\\]Settings\w+(Section|Zone)\.svelte$/.test(file)
    );
    expect(sections.length).toBeGreaterThanOrEqual(7);
    for (const { file, body } of sections) {
      expect(body, file).not.toMatch(/rounded-xl[^"]*p-2\.5[^"]*">\s*<\w+ size=\{22\}/);
      for (const h of body.matchAll(/<h2\b([^>]*)>/g)) {
        expect(h[1], file).toContain('sr-only');
      }
    }
  });
});
