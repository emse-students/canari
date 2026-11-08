import type { GuideDefinition } from '../guideTypes';
import { associationManageHint, associationManageHubHint } from './associationManageHint';
import { associationShopHint } from './associationShopHint';
import { bookingSpacesHint } from './bookingSpacesHint';
import { bookingWeekHint } from './bookingWeekHint';
import { chatsHint } from './chatsHint';
import { postAsHint } from './postAsHint';
import { profilePhotoPrompt, profilePhotoReminder } from './profilePhotoPrompt';
import { birthdayPrompt } from './birthdayPrompt';
import { createEventHint } from './createEventHint';
import { createFormHint } from './createFormHint';
import { createPostHint } from './createPostHint';
import { feedTabsHint } from './feedTabsHint';
import { reelsHint } from './reelsHint';
import { welcomeTour } from './welcomeTour';

/**
 * EVERY FIRST-TIME HELP THE APP DECLARES, IN PRIORITY ORDER: when several apply to a route and none
 * is seen, the first one starts, and the next waits for the next quiet moment. A new help is a file
 * beside this one and a line here (docs/wiki/frontend/guided-help.md#declaring-a-help). The tour is
 * first, then the current version's news (an account that has not met the tour is never offered it).
 */
export const GUIDES: readonly GuideDefinition[] = [
  welcomeTour,
  // Right after the tour: an existing account is offered it at its first visit after the update,
  // before the contextual hints (one help per visit, so those wait for the next).
  profilePhotoPrompt,
  profilePhotoReminder,
  // After the photo prompts: an account missing both meets the photo first, the birthday on a later
  // visit (one help per visit).
  birthdayPrompt,
  createPostHint,
  feedTabsHint,
  reelsHint,
  createEventHint,
  createFormHint,
  chatsHint,
  postAsHint,
  associationShopHint,
  associationManageHint,
  associationManageHubHint,
  bookingSpacesHint,
  bookingWeekHint,
];
