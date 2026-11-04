import { Building2, UserCheck, Users } from '@lucide/svelte';
import { m } from '$lib/paraglide/messages';
import type { GuideDefinition } from '../guideTypes';

/**
 * FIRST-TIME HINT - what each feed tab shows. It REPLACES the permanent (i) button of #2857 (owner,
 * 2026-11-03): the explanation is met once, tab by tab, on the real tabs (`FeedTabRow` marks each
 * `posts.tab.<feed>`), and the texts are the `posts_tabs_info_*` ones the button carried.
 */
export const feedTabsHint: GuideDefinition = {
  id: 'hint-feed-tabs',
  kind: 'hint',
  appliesTo: (pathname) => pathname === '/posts',
  steps: [
    {
      id: 'associations',
      anchor: 'posts.tab.associations',
      icon: Building2,
      title: m.posts_tabs_info_associations_title,
      body: m.posts_tabs_info_associations_body,
    },
    {
      id: 'followed',
      anchor: 'posts.tab.followed',
      icon: UserCheck,
      title: m.posts_tabs_info_followed_title,
      body: m.posts_tabs_info_followed_body,
    },
    {
      id: 'all',
      anchor: 'posts.tab.all',
      icon: Users,
      title: m.posts_tabs_info_all_title,
      body: m.posts_tabs_info_all_body,
    },
  ],
};
