import type { GuideDefinition } from '../guideTypes';
import { createEventHint } from './createEventHint';
import { createFormHint } from './createFormHint';
import { createPostHint } from './createPostHint';
import { welcomeTour } from './welcomeTour';

/**
 * EVERY FIRST-TIME HELP THE APP DECLARES, IN PRIORITY ORDER: when several apply to a route and none
 * is seen, the first one starts, and the next waits for the next quiet moment. A new help is a file
 * beside this one and a line here (docs/wiki/frontend/guided-help.md#declaring-a-help).
 */
export const GUIDES: readonly GuideDefinition[] = [
  welcomeTour,
  createPostHint,
  createEventHint,
  createFormHint,
];
