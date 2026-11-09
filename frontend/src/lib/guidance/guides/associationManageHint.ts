import { CalendarDays, Settings } from '@lucide/svelte';
import { m } from '$lib/paraglide/messages';
import type { GuideDefinition } from '../guideTypes';
import { isAssociationManagementHub, isAssociationPage } from './associationRoutes';

/**
 * FIRST-TIME HINTS FOR WHO MANAGES AN ASSOCIATION - two helps, because the two places are two
 * routes and a hint never follows a navigation.
 *
 * 1. `hint-asso-manage`, on the association's page: the "Gestion de l'asso" link (it OPENS the
 *    management area) and the Agenda row, where the association's events are added. Both are marked
 *    by the page only when `canManage` holds - the very condition that draws the link - and the
 *    agenda row also needs the event-proposal right the agenda section edits by, so a non-manager
 *    has no anchor and the help is never offered.
 * 2. `hint-asso-manage-hub`, on the management hub (`/associations/<slug>/edit`): the Members row
 *    (the roster and each member's rights) and the Public row (the audience). The hub draws a row
 *    only for a reader who holds its right (`visibleEditSections`), so the audience step is left
 *    out for a manager without it, and nobody without the members right is shown the first.
 *
 * Neither declares `replay`: both belong to one association's route.
 */
export const associationManageHint: GuideDefinition = {
  id: 'hint-asso-manage',
  kind: 'hint',
  appliesTo: isAssociationPage,
  steps: [
    {
      id: 'manage',
      anchor: 'asso.manage',
      icon: Settings,
      title: m.guide_hint_asso_manage_title,
      body: m.guide_hint_asso_manage_body,
    },
    {
      id: 'agenda',
      anchor: 'asso.agenda',
      icon: CalendarDays,
      title: m.guide_hint_asso_agenda_title,
      body: m.guide_hint_asso_agenda_body,
    },
  ],
};

export const associationManageHubHint: GuideDefinition = {
  id: 'hint-asso-manage-hub',
  kind: 'hint',
  appliesTo: isAssociationManagementHub,
  steps: [
    {
      id: 'members',
      anchor: 'asso.edit.members',
      icon: Settings,
      title: m.guide_hint_asso_hub_members_title,
      body: m.guide_hint_asso_hub_members_body,
    },
    {
      id: 'audience',
      anchor: 'asso.edit.audience',
      icon: Settings,
      title: m.guide_hint_asso_hub_audience_title,
      body: m.guide_hint_asso_hub_audience_body,
    },
  ],
};
