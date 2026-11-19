import { Log } from '$lib/utils/Log';
import { refusalCode } from '$lib/utils/apiRefusal';
import { formWindowState, windowRefusalState, type FormWindowState } from './formWindow';
import type { Form } from './api';

/**
 * What a fill page says about its form's window: the SERVER's verdict of the load (`windowState`,
 * `formWindowState`), or of the last typed refusal of an answer while the page stayed open.
 *
 * A `FORM_CLOSED` / `FORM_NOT_OPEN_YET` refusal is the server's NEWER answer (a manager closed the
 * form, an end came, an opening moved): `adopt` takes it and the page redraws. `clear` drops it when
 * a successful read brings the form's own state again. Never a clock: no date is compared here.
 * Shared by the member page and the public page, so the two cannot drift.
 */
export function useFormWindow(
  getForm: () => Partial<Pick<Form, 'opensAt' | 'closedAt' | 'windowState'>> | null | undefined,
  logTag: string
) {
  let refused = $state<FormWindowState | null>(null);
  const state = $derived(refused ?? formWindowState(getForm()));
  return {
    /** The window state now: the last refusal's, else the loaded form's. */
    get state(): FormWindowState {
      return state;
    },
    get closed(): boolean {
      return state === 'closed';
    },
    get notYet(): boolean {
      return state === 'not-yet';
    },
    /** Takes a refusal's proof of the window state; any other error changes nothing. */
    adopt(err: unknown): void {
      const proved = windowRefusalState(refusalCode(err));
      if (!proved) return;
      Log.d(logTag, `the server refused an answer: the form is now ${proved}`);
      refused = proved;
    },
    /** A successful read of the form brought its own, newer state. */
    clear(): void {
      refused = null;
    },
  };
}
