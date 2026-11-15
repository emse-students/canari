import { goto } from '$app/navigation';
import { resolve } from '$app/paths';
import { internalPath, loginAfterSessionExpiry } from '$lib/utils/internalPath';

/**
 * Sends a dead session to `/login` CARRYING the page it was on (`loginAfterSessionExpiry`). Every
 * route to the sign-in after a verdict goes through here or through the app shell's own handler: a
 * bare `/login` dropped the page a tapped push was going to (Mi 9T, 2026-11-15).
 */
export function gotoLoginAfterExpiry(): Promise<void> {
  const loginPath = loginAfterSessionExpiry(typeof window === 'undefined' ? null : window.location);
  return goto(resolve(internalPath(loginPath)), { replace: true });
}
