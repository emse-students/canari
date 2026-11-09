import { Cake } from '@lucide/svelte';
import { goto } from '$app/navigation';
import { resolve } from '$app/paths';
import { internalPath } from '$lib/utils/internalPath';
import { m } from '$lib/paraglide/messages';
import { profileSectionHref } from '$lib/profile/profileSections';
import { ownBirthday } from '$lib/birthdays/birthdaysToday.svelte';
import type { GuideDefinition } from '../guideTypes';

/**
 * THE BIRTHDAY PROMPT (docs/wiki/birthdays.md): ONE card, once, to an account with no birthday,
 * whose button opens Profile > Anniversaire. Built on the profile-photo prompt's engine, so "seen"
 * is the account's own server-side `help_seen`, across devices, and "Passer" counts as seen.
 *
 * WHY A CARD AT ALL (decided while building, 2026-11-08): the field is empty for every existing
 * account, and the ring and the followers' notice exist only for a member who entered a date - a
 * settings row nobody opens would leave the feature invisible. WHY NO REMINDER, unlike the photo: a
 * birthday is personal data the member may simply not want to give, so asking twice would be
 * pressure; the profile section stays the way back.
 *
 * Shown on the feed, after the photo prompts (one help per visit, so never beside them). `null` -
 * nobody could say whether a date is entered - shows NOTHING.
 */
export const birthdayPrompt: GuideDefinition = {
  id: 'prompt-birthday',
  kind: 'tour',
  appliesTo: (pathname) => pathname === '/posts',
  eligible: () => ownBirthday.hasBirthday === false,
  steps: [
    {
      id: 'birthday',
      anchor: null,
      icon: Cake,
      title: m.guide_birthday_title,
      body: m.guide_birthday_body,
      action: {
        label: m.guide_birthday_action,
        run: () => void goto(resolve(internalPath(profileSectionHref('birthday')))),
      },
    },
  ],
};
