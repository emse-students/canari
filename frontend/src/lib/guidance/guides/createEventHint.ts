import { CalendarPlus } from '@lucide/svelte';
import { m } from '$lib/paraglide/messages';
import type { GuideDefinition } from '../guideTypes';

/**
 * FIRST-TIME HINT - depositing an event. The form is a modal (no help runs over it), so the hint
 * points at the "Déposer un événement" button of the agenda, drawn only for an account that may
 * post on at least one association: for anyone else the step is left out (not-rendered) and the
 * hint is never offered. The body names what the deposit does that a first-timer would not guess -
 * it is made on behalf of an association and waits for a validation.
 */
export const createEventHint: GuideDefinition = {
  id: 'hint-create-event',
  kind: 'hint',
  appliesTo: (pathname) => pathname === '/calendar',
  steps: [
    {
      id: 'deposit',
      anchor: 'calendar.deposit',
      icon: CalendarPlus,
      title: m.guide_hint_create_event_title,
      body: m.guide_hint_create_event_body,
    },
  ],
};
