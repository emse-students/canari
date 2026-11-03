import { SquarePen } from '@lucide/svelte';
import { m } from '$lib/paraglide/messages';
import type { GuideDefinition } from '../guideTypes';

/**
 * FIRST-TIME HINT - the post composer's entry. The composer itself is a modal, and a help never runs
 * over a modal (the quiet state), so the hint points at the control that OPENS it: the "+" of the
 * phone header and the "Publier" button of the desktop heading, both marked `posts.compose` - the
 * one drawn wins. What a first-timer would miss (publishing as an association, scheduling, a poll,
 * a form) is said in the body, since the composer's own controls cannot be pointed at.
 */
export const createPostHint: GuideDefinition = {
  id: 'hint-create-post',
  kind: 'hint',
  appliesTo: (pathname) => pathname === '/posts',
  steps: [
    {
      id: 'compose',
      anchor: 'posts.compose',
      icon: SquarePen,
      title: m.guide_hint_create_post_title,
      body: m.guide_hint_create_post_body,
    },
  ],
};
