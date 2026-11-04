import { House } from '@lucide/svelte';
import { m } from '$lib/paraglide/messages';
import type { GuideDefinition } from '../guideTypes';

/**
 * FIRST-TIME HINT - the "Mon espace" tab of the feed (`posts.tab.all`, marked by `FeedTabRow`):
 * what the reader's own space holds. The feed-tabs hint already names every tab once in a line; this
 * one is the owner's separate batch 3 item for the campus space, so it comes later, on its own visit.
 */
export const mySpaceHint: GuideDefinition = {
  id: 'hint-my-space',
  kind: 'hint',
  appliesTo: (pathname) => pathname === '/posts',
  replay: { label: m.guide_hint_my_space_title, route: '/posts' },
  steps: [
    {
      id: 'my-space',
      anchor: 'posts.tab.all',
      icon: House,
      title: m.guide_hint_my_space_title,
      body: m.guide_hint_my_space_body,
    },
  ],
};
