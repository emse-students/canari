/**
 * ASKS BEFORE AN EDITOR WITH UNSAVED CHANGES IS LEFT.
 *
 * Call it during a component's initialisation (it registers SvelteKit's `beforeNavigate`). While
 * `isDirty()` holds, closing or reloading the tab gets the browser's own prompt - the only one a
 * page may show there - and an in-app navigation is held, asked with the app's dialog, and
 * replayed when the reader confirms. `release()` lets the next navigation through unasked, for a
 * leave the editor itself decided (the thing edited was deleted).
 */
import { beforeNavigate, goto } from '$app/navigation';
import { resolve } from '$app/paths';
import { showConfirm } from '$lib/stores/confirm.svelte';
import { appPathFromPathname, internalPath } from '$lib/utils/internalPath';
import { Log } from '$lib/utils/Log';

export function guardUnsavedChanges(
  isDirty: () => boolean,
  message: () => string
): { release: () => void } {
  let released = false;
  beforeNavigate((nav) => {
    if (released || !isDirty()) return;
    // A shallow navigation stays on the page (a tab, a query), so it leaves nothing unsaved behind.
    if (nav.shallow && nav.type === 'goto') return;
    if (nav.type === 'leave') {
      Log.d('NAV', 'unsaved changes: the browser asks before the tab closes');
      nav.cancel();
      return;
    }
    const target = nav.to?.url;
    nav.cancel();
    if (!target) return;
    Log.d('NAV', `unsaved changes: asking before ${target.pathname}`);
    void showConfirm(message(), { danger: true }).then((leave) => {
      if (!leave) return;
      released = true;
      const path = `${appPathFromPathname(target.pathname)}${target.search}${target.hash}`;
      void goto(resolve(internalPath(path)));
    });
  });
  return {
    release: () => {
      released = true;
    },
  };
}
