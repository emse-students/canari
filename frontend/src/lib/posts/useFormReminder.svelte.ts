import { subscribeFormReminder, unsubscribeFormReminder, checkFormReminder } from './api';

/** Manages subscribe/unsubscribe state for a single form's open-time reminder. */
export function useFormReminder(formId: string) {
  let subscribed = $state(false);
  let toggling = $state(false);

  /** Fetches the current subscription state from the API. */
  async function load() {
    try {
      subscribed = (await checkFormReminder(formId)).subscribed;
    } catch {
      /* non-fatal */
    }
  }

  /** Toggles the subscription, calling subscribe or unsubscribe as appropriate. */
  async function toggle() {
    if (toggling) return;
    toggling = true;
    try {
      if (subscribed) {
        await unsubscribeFormReminder(formId);
        subscribed = false;
      } else {
        await subscribeFormReminder(formId);
        subscribed = true;
      }
    } catch {
      /* non-fatal */
    } finally {
      toggling = false;
    }
  }

  return {
    get subscribed() {
      return subscribed;
    },
    get toggling() {
      return toggling;
    },
    load,
    toggle,
  };
}
