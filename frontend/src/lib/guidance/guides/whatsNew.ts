import { CheckCheck, Pin } from '@lucide/svelte';
import { m } from '$lib/paraglide/messages';
import type { GuideDefinition } from '../guideTypes';
import { besideTheRail } from './placements';

/**
 * "WHAT'S NEW" OF THE CURRENT VERSION (owner, 2026-11-03): 2 to 5 steps, on the real interface,
 * pointing ONLY at what changed in this version, shown ONCE per version per account, skippable.
 *
 * ONE DECLARATION PER VERSION, and only the latest is in `GUIDES`: an account that skipped a version
 * is shown the current news, never a backlog. Shipping the next version means a new file here, a new
 * id (`whats-new-<major>-<minor>-<patch>`) in the three allowlists, this file dropped from `GUIDES`
 * (its id stays allowlisted: the rows already written stay valid) - see
 * docs/wiki/frontend/guided-help.md#whats-new.
 *
 * `requires: 'welcome-tour'`: an account that has not met the tour is new to the app and gets the
 * tour instead; the tour `supersedes` this id so its next visit does not open with the news either.
 * A hint, not a tour: nothing is blocked behind it, the iOS native bar included.
 */
export const whatsNew163: GuideDefinition = {
  id: 'whats-new-1-6-3',
  kind: 'hint',
  requires: 'welcome-tour',
  appliesTo: (pathname) => pathname === '/posts',
  steps: [
    {
      id: 'pins',
      anchor: 'posts.tab.all',
      icon: Pin,
      title: m.guide_whats_new_pins_title,
      body: m.guide_whats_new_pins_body,
    },
    {
      id: 'read',
      anchor: 'nav.chat',
      placement: besideTheRail,
      icon: CheckCheck,
      title: m.guide_whats_new_read_title,
      body: m.guide_whats_new_read_body,
    },
  ],
};
