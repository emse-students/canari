/**
 * A LONG PRESS ON A BUBBLE OPENS THE MENU ONLY - NO NATIVE TEXT SELECTION (owner, 2026-11-08, iPhone).
 *
 * ROOT CAUSE: the bubble is `select-none` on mobile, but the text `<p>` inside it is `select-text`
 * (the opt-in the coarse-pointer inversion in app.css needs), and an explicit `user-select: text`
 * on a child beats the parent's `none`. So iOS selected the word under the finger and showed its
 * handles alongside the action sheet. The fix lives on the two text nodes themselves: on a coarse
 * pointer they are not selectable and carry no callout, decided by CSS media (immediate, no
 * dependence on the `isMobile` prop that is false until the layout effect runs). A mouse keeps
 * `select-text`; "Copier" covers the touch case.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = resolve(import.meta.dirname);

describe.each(['MessageTextBody.svelte', 'MessageMediaRenderer.svelte'])('%s', (file) => {
  const src = readFileSync(resolve(dir, file), 'utf8');
  it('keeps select-text for a mouse but turns it off on a coarse pointer', () => {
    expect(src).toMatch(/select-text pointer-coarse:select-none/);
    expect(src).toContain('pointer-coarse:[-webkit-touch-callout:none]');
  });
});
