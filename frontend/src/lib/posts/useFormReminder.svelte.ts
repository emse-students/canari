import { subscribeFormReminder, unsubscribeFormReminder, checkFormReminder } from './api';

/**
 * Manages subscribe/unsubscribe state for a form's open-time reminder. `formId` is READ AT EACH
 * CALL: the form page is reused from one form to the next, and a reminder bound to the first id
 * would subscribe the reader to the wrong form.
 */
export function useFormReminder(formId: () => string) {
  let subscribed = $state(false);
  let toggling = $state(false);
  let loaded = $state(false);

  /** Fetches the current subscription state from the API. */
  async function load() {
    const id = formId();
    subscribed = false;
    loaded = false;
    try {
      const answer = (await checkFormReminder(id)).subscribed;
      if (id === formId()) subscribed = answer;
    } catch (err) {
      // Non-fatal: the bell reads "off" - said, never swallowed.
      console.warn('[formReminder] could not read the reminder state:', err);
    } finally {
      loaded = true;
    }
  }

  /** Toggles the subscription, calling subscribe or unsubscribe as appropriate. */
  async function toggle() {
    if (toggling) return;
    toggling = true;
    try {
      if (subscribed) {
        await unsubscribeFormReminder(formId());
        subscribed = false;
      } else {
        await subscribeFormReminder(formId());
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
    get loaded() {
      return loaded;
    },
    load,
    toggle,
  };
}
