import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The login card is flat: the ecosystem checklist (docs/wiki/ecosystem-convergence.md section 12)
 * counted two glows on it against zero on the reference apps, and every one was a utility class in
 * this file. Asserting the classes' absence is the whole guard - a glow here can only come back as
 * one of them.
 */
describe('LoginForm', () => {
  const source = readFileSync(resolve(import.meta.dirname, 'LoginForm.svelte'), 'utf8');
  // The markup's CLASSES, so the comment explaining the rule does not trip it.
  const markup = source.slice(source.indexOf('</script>')).replace(/<!--[\s\S]*?-->/g, '');

  it('draws no shadow, drop-shadow or glow on any component', () => {
    expect(markup).not.toMatch(/\b(?:drop-)?shadow(?:-[\w/[\]().,]+)?\b/);
  });
});
