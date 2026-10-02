/**
 * THE BOTTOM BAR IS ITS OWN VIEW-TRANSITION GROUP DURING A TAB SWIPE (Mi 9T, 2026-10-02).
 *
 * The page wrapper's snapshot is a named group, and named groups stack above `root` - where the
 * `fixed` bar is drawn - so the incoming page covered the bar for the whole slide (~270 ms) and the
 * bar popped in when the transition ended. Read on screen-recorded frames, camera -> feed. A name on
 * the bar, only while `data-swipe-nav` is set, paints it above the pages from the first frame.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const APP_CSS = readFileSync('src/app.css', 'utf8');
const NAV = readFileSync('src/lib/components/navigation/BottomNav.svelte', 'utf8');

describe('the bottom bar during a tab swipe', () => {
  it('is named only while a swipe is under way, and the selector hits the real bar', () => {
    expect(APP_CSS).toMatch(
      /html\[data-swipe-nav\] #bottom-nav\s*\{\s*view-transition-name: bottom-nav;/
    );
    expect(NAV).toContain('id="bottom-nav"');
    // never a permanent name: it would make the bar a group of every navigation
    expect(APP_CSS).not.toMatch(/(^|\n)#bottom-nav\s*\{[^}]*view-transition-name/);
  });

  it('is never faded, morphed or left behind: old hidden, group and new do not animate', () => {
    expect(APP_CSS).toMatch(/::view-transition-old\(bottom-nav\)\s*\{\s*display: none;/);
    expect(APP_CSS).toMatch(
      /::view-transition-group\(bottom-nav\),\s*html\[data-swipe-nav\]::view-transition-new\(bottom-nav\)\s*\{\s*animation: none;/
    );
  });
});
