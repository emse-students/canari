/**
 * WHAT A TAB TAP PAYS BEFORE THE PAGE IT ASKED FOR (Mi 9T, community-open-budget, 2026-10-15).
 *
 * Three costs sat on the path from a tap on the bottom bar to the communities page, each measured
 * there and each pinned here by the shape of the markup that removes it:
 *
 * - the double-tap window: the bar is outside `.page-scroll-wrap` (whose `pan-y pinch-zoom` turns
 *   double-tap zoom off), so the click waited ~120 ms after `touchend` for a second tap;
 * - the per-navigation code preload: `data-sveltekit-preload-code="viewport"` re-preloads every
 *   visible tab after each navigation, 60-118 ms of Vite's preload helper per tap;
 * - the feed's conversations panel, drawn only at `xl` and mounted everywhere.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { withoutComments } from '$lib/styles/markupSources';

const read = (path: string) => withoutComments(readFileSync(path, 'utf8'));
const BOTTOM_NAV = read('src/lib/components/navigation/BottomNav.svelte');
const APP_SIDEBAR = read('src/lib/components/navigation/AppSidebar.svelte');
const FEED_PAGE = read('src/routes/posts/+page.svelte');
const LAYOUT = read('src/routes/+layout.svelte');

describe('the path of a tab tap', () => {
  it('the bottom bar does not wait for a double tap', () => {
    expect(BOTTOM_NAV).toMatch(/<nav\s+id="bottom-nav"\s+class="[^"]*\btouch-manipulation\b/);
  });

  it('no navigation link asks SvelteKit to re-preload its route after every navigation', () => {
    for (const source of [BOTTOM_NAV, APP_SIDEBAR]) {
      expect(source).not.toContain('data-sveltekit-preload-code');
      expect(source).toContain('use:preloadRouteOnView=');
    }
  });

  it('the swipe neighbours are preloaded once per document, not on every arrival', () => {
    expect(LAYOUT).not.toMatch(/\bpreloadCode\(/);
    expect(LAYOUT).toContain('preloadRouteCodeOnce(href)');
  });

  it('the feed mounts its conversations panel only where the layout draws it', () => {
    expect(FEED_PAGE).toMatch(
      /\{#if !overlayLayout\(\)\}\s*<ConversationsMiniPanel \/>\s*\{\/if\}/
    );
    // The panel's own class is what draws it at `xl`, the same boundary `overlayLayout` names.
    expect(read('src/lib/components/posts/ConversationsMiniPanel.svelte')).toMatch(
      /class="[^"]*\bhidden\b[^"]*\bxl:flex\b/
    );
  });
});
