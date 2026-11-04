import { Megaphone } from '@lucide/svelte';
import { m } from '$lib/paraglide/messages';
import { canPostAsAssociation } from '$lib/posts/postAsAccess.svelte';
import type { GuideDefinition } from '../guideTypes';

/**
 * FIRST-TIME HINT - publishing in an association's name. The composer is a modal (no help runs over
 * it), so the hint points at the control that OPENS it - the same `posts.compose` anchor the
 * "publish a post" hint uses, a phone header "+" or the desktop "Publier" button - and its text
 * names the "Publier en tant que" picker the reader will find at the top of the form.
 *
 * `eligible` is the list the picker itself offers (`canPostAsAssociation`): an account that may
 * speak for no association is never shown it. It declares no `replay`, because a replay of an
 * ineligible help would wait forever for an account it is not for.
 */
export const postAsHint: GuideDefinition = {
  id: 'hint-asso-post-as',
  kind: 'hint',
  appliesTo: (pathname) => pathname === '/posts',
  eligible: canPostAsAssociation,
  steps: [
    {
      id: 'post-as',
      anchor: 'posts.compose',
      icon: Megaphone,
      title: m.guide_hint_post_as_title,
      body: m.guide_hint_post_as_body,
    },
  ],
};
