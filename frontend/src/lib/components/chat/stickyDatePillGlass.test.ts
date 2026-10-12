/**
 * THE FLOATING DAY PILL IS GLASS, NOT AN OPAQUE CHIP (iPhone, 2026-10-09): scrolling a salon, a
 * sender name passed under the pill and read "Canari Test De" then the chip. Layout cannot avoid
 * that - the pill floats over moving content by design - so the surface must blur what is under it.
 * No rendering test sees a backdrop, so the gate reads the rule.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const css = readFileSync('src/app.css', 'utf8');

describe('.chat-sticky-date-indicator', () => {
  const rule = css.match(/\.chat-sticky-date-indicator \{([^}]*)\}/)?.[1] ?? '';

  it('blurs the thread under it, with the -webkit- spelling WKWebView needs', () => {
    expect(rule).toMatch(/-webkit-backdrop-filter:\s*blur\(/);
    expect(rule).toMatch(/[^-]backdrop-filter:\s*blur\(/);
  });

  it('uses the glass tokens, not an opaque surface', () => {
    expect(rule).toContain('var(--glass-chrome-bg)');
    expect(rule).not.toMatch(/background:\s*var\(--cn-surface\)/);
  });
});
