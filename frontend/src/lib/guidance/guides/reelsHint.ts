import { Clapperboard } from '@lucide/svelte';
import { m } from '$lib/paraglide/messages';
import type { GuideDefinition } from '../guideTypes';

/**
 * FIRST-TIME HINT - the CanaReels icon at the right end of the feed's tab row. It points at the
 * control that OPENS the full-screen viewer (a help never runs over a viewer, and never points
 * inside one), and says what the viewer holds.
 */
export const reelsHint: GuideDefinition = {
  id: 'hint-reels',
  kind: 'hint',
  appliesTo: (pathname) => pathname === '/posts',
  steps: [
    {
      id: 'reels',
      anchor: 'posts.reels',
      icon: Clapperboard,
      title: m.guide_hint_reels_title,
      body: m.guide_hint_reels_body,
    },
  ],
};
