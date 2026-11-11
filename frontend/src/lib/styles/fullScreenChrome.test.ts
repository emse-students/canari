/**
 * A FULL-SCREEN PLACE DRAWS NO CHROME, AT ANY WIDTH (owner, Android 1.6.10, 2026-11-11).
 *
 * Turned to landscape, a phone is 800+ px wide and crosses Tailwind `md`: the sidebar and the top
 * bar - `md:` pieces - came back around the camera, which shrank into what was left. Chrome is
 * decided by the PLACE (`isFullScreenPlace`), never by a width. The root layout is not renderable
 * in a unit test (the whole app boots in it), so this pins its source: every chrome piece is behind
 * `!isFullScreen`, and so is the gutter that makes room for the sidebar.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isFullScreenPlace } from '$lib/navigation/places';
import { withoutComments } from './markupSources';

const layout = withoutComments(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../routes/+layout.svelte'), 'utf8')
).replace(/\r\n/g, '\n');

describe('the root layout on a full-screen place', () => {
  it('knows the camera as one, with its sub-routes', () => {
    expect(isFullScreenPlace('/camera')).toBe(true);
    expect(isFullScreenPlace('/camera/review')).toBe(true);
    expect(isFullScreenPlace('/chat')).toBe(false);
  });

  it.each(['<AppSidebar />', '<Navbar />', '<MobileHeader />', '<BottomNav />'])(
    '%s is not rendered there, whatever the width',
    (piece) => {
      const at = layout.indexOf(piece);
      expect(at, `${piece} is in the layout`).toBeGreaterThan(-1);
      // The `{#if ...}` that opens the block holding the piece, on the line(s) just above it.
      const guard = layout.slice(Math.max(0, at - 260), at);
      expect(guard).toMatch(/\{(#if|:else if)[^}]*!isFullScreen/);
    }
  );

  it('does not reserve the sidebar gutter there', () => {
    expect(layout).toMatch(/isLoginPage \|\| isFullScreen\s*\? ''\s*: 'md:pl-24'/);
  });
});
