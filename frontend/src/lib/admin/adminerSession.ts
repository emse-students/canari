import { apiFetch } from '$lib/utils/apiFetch';
import { coreUrl } from '$lib/utils/apiUrl';
import { Log } from '$lib/utils/Log';

/**
 * The server does not offer Adminer here (404): this estate never enables it, which is development's
 * deliberate state. Typed at the throw so the page can say so instead of calling it a failure.
 */
export class AdminerUnavailableError extends Error {
  constructor() {
    super('adminer is not enabled on this server');
    this.name = 'AdminerUnavailableError';
  }
}

/** The caller is not a global admin (403), whatever the interface showed them. */
export class AdminerForbiddenError extends Error {
  constructor() {
    super('adminer is for global admins only');
    this.name = 'AdminerForbiddenError';
  }
}

/** Where the database admin UI lives. A path of the app's own origin, so the cookie reaches it. */
export const ADMINER_PATH = '/adminer/';

/**
 * Asks core-service for an Adminer session.
 *
 * The answer is a `Set-Cookie` (`canari_adminer`, HttpOnly, Secure, SameSite=Strict, path
 * `/adminer/`, fifteen minutes) and nothing in the body worth keeping: a browser that OPENS a page
 * sends no `Authorization` header, so this authenticated call is where the admin proves who they are,
 * and the cookie is what carries it to the page. Resolves with the session's length in seconds.
 */
export async function openAdminerSession(): Promise<number> {
  Log.d('adminerSession', 'asking for a session');
  const res = await apiFetch(`${coreUrl()}/api/auth/adminer-session`, { method: 'POST' });
  if (res.status === 404) throw new AdminerUnavailableError();
  if (res.status === 403) throw new AdminerForbiddenError();
  if (!res.ok) throw new Error(`Adminer session refused (${res.status})`);
  const body = (await res.json()) as { expiresInSeconds?: number };
  return typeof body.expiresInSeconds === 'number' ? body.expiresInSeconds : 0;
}

/**
 * Opens a session, then Adminer in a NEW tab.
 *
 * The tab is opened BEFORE the request, in the click's own turn: a window opened after an `await`
 * is no longer a user gesture and a popup blocker drops it. It is pointed at Adminer once the
 * cookie exists, and closed again if the session could not be opened, so a failure never leaves a
 * blank tab behind.
 */
export async function openAdminer(): Promise<void> {
  const tab = window.open('about:blank', '_blank');
  try {
    await openAdminerSession();
  } catch (err) {
    tab?.close();
    throw err;
  }
  if (!tab) {
    // Popups are blocked for this site: go there in this tab rather than do nothing.
    window.location.assign(ADMINER_PATH);
    return;
  }
  // The opener link is cut once the tab is ours to steer - Adminer must not be able to reach back.
  tab.opener = null;
  tab.location.href = ADMINER_PATH;
}
