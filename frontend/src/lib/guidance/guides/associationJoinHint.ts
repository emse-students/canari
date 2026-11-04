import { Bell, HandHeart, Users } from '@lucide/svelte';
import { m } from '$lib/paraglide/messages';
import type { GuideDefinition } from '../guideTypes';
import { isAssociationPage } from './associationRoutes';

/**
 * FIRST-TIME HINT - an association's own page: where to follow it, see its members and join it.
 * Starts on the first association page an account opens, once per account.
 *
 * Every step points at a real control of `AssociationDetailView`, and the page marks each one ONLY
 * for a reader it concerns (the page's own facts, no second definition): the follow button is drawn
 * for a signed-in reader; the members row always; and the join step - the shop row, where the
 * membership card with its tiers is - only for a reader who is NOT yet a member and only when the
 * association offers a tier. A control not drawn leaves its step out (not-rendered), so a member
 * is never told how to join. The page loads after the route settles, so the help starts when its
 * anchors mount.
 */
export const associationJoinHint: GuideDefinition = {
  id: 'hint-asso-join',
  kind: 'hint',
  appliesTo: isAssociationPage,
  steps: [
    {
      id: 'follow',
      anchor: 'asso.follow',
      icon: Bell,
      title: m.guide_hint_asso_follow_title,
      body: m.guide_hint_asso_follow_body,
    },
    {
      id: 'members',
      anchor: 'asso.members',
      icon: Users,
      title: m.guide_hint_asso_members_title,
      body: m.guide_hint_asso_members_body,
    },
    {
      id: 'join',
      anchor: 'asso.join',
      icon: HandHeart,
      title: m.guide_hint_asso_join_title,
      body: m.guide_hint_asso_join_body,
    },
  ],
};
