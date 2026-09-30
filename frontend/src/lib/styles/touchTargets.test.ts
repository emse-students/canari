/**
 * The 44px touch floor, held in the stylesheet (viewport audit, 2026-09-30).
 *
 * Two rules, each one line of CSS that a later edit could undo without any test noticing:
 * 1. `.ui-icon-button` shrinks to 38px under a POINTER, not from a width - 768px also describes a
 *    touch tablet, whose header icons measured 38px in portrait.
 * 2. `.tap-target` gives a control drawn under 44px an invisible 44px hit box on a touch screen.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// A Windows checkout reads CRLF, and every pattern below is written in LF.
const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'app.css'),
  'utf8'
).replace(/\r\n/g, '\n');

/** The body of the first block that starts with `head`, up to its closing brace at `indent`. */
function block(head: string, indent = '  '): string {
  const start = css.indexOf(head);
  expect(start, `${head} is in app.css`).toBeGreaterThan(-1);
  const rest = css.slice(start);
  return rest.slice(0, rest.indexOf(`\n${indent}}`));
}

describe('the 44px touch floor', () => {
  it('shrinks the icon button to 38px only under a fine pointer', () => {
    const pointer = block('@media (min-width: 768px) and (pointer: fine) {\n    .ui-icon-button {');
    expect(pointer).toContain('width: 2.375rem;');
    // No width-only rule may shrink it: that is the one a touch tablet also matches.
    expect(css).not.toContain('@media (min-width: 768px) {\n    .ui-icon-button {');
  });

  it('shrinks the chat composer field under the same condition as its buttons', () => {
    const field = block(
      '@media (min-width: 768px) and (pointer: fine) {\n  .chat-composer-panel {',
      ''
    );
    expect(field).toContain('--composer-field-height');
  });

  it('gives a tap target a 44px hit box on a touch screen, and nothing under a pointer', () => {
    const coarse = block('@media (pointer: coarse) {\n    .tap-target::before {');
    expect(coarse).toContain('width: max(100%, 2.75rem);');
    expect(coarse).toContain('height: max(100%, 2.75rem);');
    expect(coarse).toContain('position: absolute;');
    // The base rule carries the anchor and nothing else: no hit box outside the coarse query.
    expect(block('.tap-target {')).not.toContain('::before');
  });
});
