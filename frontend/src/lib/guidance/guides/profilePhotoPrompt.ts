import { Camera } from '@lucide/svelte';
import { m } from '$lib/paraglide/messages';
import { openProfilePhotoPage } from '$lib/utils/profilePhotoLink';
import type { GuideDefinition, GuideStep } from '../guideTypes';
import { ownProfilePhoto } from '../ownProfilePhoto.svelte';
import { seenHelps } from '../seenHelps.svelte';
import { profilePhotoPromptStage } from './profilePhotoPromptStage';

/**
 * THE PROFILE-PHOTO PROMPT (owner, 2026-11-07) - two helps on the one engine, so "seen" is the
 * account's own server-side `help_seen`, across devices, like every other help:
 *
 * - `prompt-profile-photo`: shown ONCE to an account with no photo, a centred card whose button opens
 *   MiGallery, where photos are set;
 * - `prompt-profile-photo-reminder`: shown ONCE, 30 days after the first one's recorded instant (the
 *   server's `seen_at`, handed to the client as an age) if there is still no photo. Never a third.
 *
 * Which one is due is {@link profilePhotoPromptStage}, a pure function of the facts read below; each
 * help's `eligible` is that function asked about its own stage. Both end (finished, skipped, Esc,
 * Back, a click on the button) by recording themselves, so neither returns.
 */
function stage() {
  return profilePhotoPromptStage({
    hasPhoto: ownProfilePhoto.hasPhoto,
    firstSeen: seenHelps.has('prompt-profile-photo'),
    reminderSeen: seenHelps.has('prompt-profile-photo-reminder'),
    firstAgeSeconds: seenHelps.ageSeconds('prompt-profile-photo'),
  });
}

const openGallery: GuideStep['action'] = {
  label: m.guide_profile_photo_action,
  run: () => void openProfilePhotoPage(),
};

export const profilePhotoPrompt: GuideDefinition = {
  id: 'prompt-profile-photo',
  kind: 'tour',
  appliesTo: (pathname) => pathname === '/posts',
  eligible: () => stage() === 'first',
  steps: [
    {
      id: 'photo',
      anchor: null,
      icon: Camera,
      title: m.guide_profile_photo_title,
      body: m.guide_profile_photo_body,
      action: openGallery,
    },
  ],
};

export const profilePhotoReminder: GuideDefinition = {
  id: 'prompt-profile-photo-reminder',
  kind: 'tour',
  appliesTo: (pathname) => pathname === '/posts',
  eligible: () => stage() === 'reminder',
  steps: [
    {
      id: 'photo-reminder',
      anchor: null,
      icon: Camera,
      title: m.guide_profile_photo_reminder_title,
      body: m.guide_profile_photo_reminder_body,
      action: openGallery,
    },
  ],
};
