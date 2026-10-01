import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Drops every HTML comment by scanning for its delimiters, so no pass can leave a half-removed one. */
function withoutHtmlComments(text: string): string {
  let out = '';
  let from = 0;
  for (;;) {
    const open = text.indexOf('<!--', from);
    if (open === -1) return out + text.slice(from);
    out += text.slice(from, open);
    const close = text.indexOf('-->', open + 4);
    if (close === -1) return out;
    from = close + 3;
  }
}

/**
 * The login card is flat: the ecosystem checklist (docs/wiki/ecosystem-convergence.md section 12)
 * counted two glows on it against zero on the reference apps, and every one was a utility class in
 * this file. Asserting the classes' absence is the whole guard - a glow here can only come back as
 * one of them.
 */
describe('LoginForm', () => {
  const source = readFileSync(resolve(import.meta.dirname, 'LoginForm.svelte'), 'utf8');
  // The markup's CLASSES, so the comment explaining the rule does not trip it.
  const markup = withoutHtmlComments(source.slice(source.indexOf('</script>')));

  it('draws no shadow, drop-shadow or glow on any component', () => {
    expect(markup).not.toMatch(/\b(?:drop-)?shadow(?:-[\w/[\]().,]+)?\b/);
  });
});
