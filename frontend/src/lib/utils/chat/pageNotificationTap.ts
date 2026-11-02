import { noteOpenRoutedNowhere } from './resumeOpening.svelte';

/** What a tap on a notification the page raised itself came to. */
export type PageNotificationTapOutcome = 'landed' | 'no-identity' | 'not-ours';

/**
 * Routes a tap on a notification the PAGE raised (the notification plugin's `onAction`): publishes
 * the conversation it was raised for as the landing, or - when the tap names no notification, or one
 * this session did not post - says the open routes NOWHERE, so a resume that this tap caused stops
 * holding the conversation it found on screen (`resumeOpening.svelte.ts`), whichever of the tap and
 * the resume's edge the page heard first.
 *
 * @param targets the conversation (group id) each notification this session posted was raised for.
 * @param publish publishes the landing (`notifNav.navigate`); the landing effect routes and selects.
 */
export function routePageNotificationTap(
  action: { notification?: { id?: number } | null } | null | undefined,
  targets: ReadonlyMap<number, string>,
  publish: (target: string) => void
): PageNotificationTapOutcome {
  const id = action?.notification?.id;
  if (typeof id !== 'number') {
    noteOpenRoutedNowhere('a page notification tap with no identity');
    return 'no-identity';
  }
  const target = targets.get(id);
  if (!target) {
    noteOpenRoutedNowhere('a tap on a notification this session did not post');
    return 'not-ours';
  }
  publish(target);
  return 'landed';
}
