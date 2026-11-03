import { noteOpenRoutedNowhere, notePageTapsRoutable } from './resumeOpening.svelte';

/** The plugin's `onAction`, as this module calls it. */
export type RegisterPageTap = (
  cb: (action: { notification?: { id?: number } | null }) => void
) => unknown;

/**
 * Registers the page's notification-tap listener and says so to the resume's hold ONLY once the
 * registration has RESOLVED (`notePageTapsRoutable`). Every other outcome - no `onAction`, a throw, a
 * rejection - is warned and leaves the hold unarmed, so a resume opening a page notification marks
 * what is on screen rather than wait for a listener that does not exist.
 */
export function armPageTapListener(
  register: RegisterPageTap | undefined,
  onTap: (action: { notification?: { id?: number } | null }) => void
): void {
  if (typeof register !== 'function') {
    console.warn(
      '[NOTIF] This plugin build exposes no onAction, so a tap cannot be observed at all. Taps ' +
        'open the app on whatever it was last showing.'
    );
    return;
  }
  let registered: unknown;
  try {
    registered = register(onTap);
  } catch (e) {
    // A plugin version whose `onAction` rejects the shape above: calling it again would throw again.
    console.warn(`[NOTIF] The notification-tap listener could not be registered: ${String(e)}`);
    return;
  }
  Promise.resolve(registered).then(
    () => notePageTapsRoutable(),
    (e: unknown) =>
      console.warn(`[NOTIF] The notification-tap listener could not be registered: ${String(e)}`)
  );
}

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
