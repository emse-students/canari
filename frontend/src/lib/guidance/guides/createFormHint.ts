import { FileText, ListChecks, Settings2 } from '@lucide/svelte';
import { m } from '$lib/paraglide/messages';
import type { GuideDefinition } from '../guideTypes';

/**
 * FIRST-TIME HINT - the form builder (`/forms/create`, a page, not a modal): the identity of the form
 * (title, and the association it belongs to - a choice that is final), its questions, and the folded
 * settings (audience, opening date, public link). Three wrappers of the page carry the anchors, so
 * the same three steps serve the phone and the desktop layouts.
 */
export const createFormHint: GuideDefinition = {
  id: 'hint-create-form',
  kind: 'hint',
  appliesTo: (pathname) => pathname === '/forms/create',
  steps: [
    {
      id: 'general',
      anchor: 'forms.create.general',
      icon: FileText,
      title: m.guide_hint_create_form_general_title,
      body: m.guide_hint_create_form_general_body,
    },
    {
      id: 'questions',
      anchor: 'forms.create.questions',
      icon: ListChecks,
      title: m.guide_hint_create_form_questions_title,
      body: m.guide_hint_create_form_questions_body,
    },
    {
      id: 'settings',
      anchor: 'forms.create.settings',
      icon: Settings2,
      title: m.guide_hint_create_form_settings_title,
      body: m.guide_hint_create_form_settings_body,
    },
  ],
};
