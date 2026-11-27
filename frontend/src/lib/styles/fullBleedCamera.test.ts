/**
 * THE CAMERA PLACE IS FULL-BLEED, AND NO RENDERING GATE HERE CAN SEE IT (iPhone 12, 2026-10-02).
 *
 * The shell pads its top by the safe-area inset for every ordinary page, which left a 47 pt black
 * strip above the preview. The shell gives that padding back on the camera place and the CONTROLS
 * clear the notch themselves - so these are source pins: remove either half and the strip returns,
 * or a button slides under the Dynamic Island, with every unit test still green. Read on the phones.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (p: string) => readFileSync(p, 'utf8');
const APP_CSS = read('src/app.css');
const INSET_TOP = 'var(--safe-area-inset-top,0px)';

describe('the camera place under the status bar', () => {
  it('the shell gives its top padding back there', () => {
    expect(APP_CSS).toMatch(/\.fullscreen-place-open \.app-shell\s*\{\s*padding-top: 0;/);
  });

  it.each([
    ['src/lib/components/reels/CameraScreen.svelte', 'close and lens controls'],
    ['src/lib/components/reels/ReelReview.svelte', 'discard button'],
    ['src/lib/components/reels/ReelPublishSheet.svelte', 'header'],
  ])('%s clears the inset itself (%s)', (file) => {
    expect(read(file)).toContain(INSET_TOP);
  });

  it('the camera holds the native status bar at light icons while it is on screen', () => {
    expect(read('src/lib/components/reels/CameraScreen.svelte')).toContain(
      "themeStore.holdNativeBar('dark')"
    );
  });
});
