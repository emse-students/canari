/**
 * THE QUESTION "IS THERE A SESSION?" ASKED BESIDE THE FIRST PAINT, NEVER IN FRONT OF IT.
 *
 * WHY IT EXISTS (2026-11-05). The root `load` used to `await refresh()` on every launch with no
 * stored user id. In an SPA nothing renders until the root `load` resolves, so on a path that hangs
 * (two users abroad, ~3 s for a tiny GET, a refresh under a 20 s deadline re-sent once) the app sat
 * on `app.html`'s inline splash for up to 40 s before even the login page was drawn. The bundle is
 * embedded in the app: the first paint needs no network, and nothing may make it wait for one.
 *
 * So the load starts this and returns; the layout draws a boot screen while the phase is
 * `resolving`, and the phase ends with the real outcome of the refresh:
 * - a token (or a sign-in that completed meanwhile) -> `settled`, the page the user asked for;
 * - an ANSWER that is not a token (401/403, identity split, ...) -> login, then `settled`;
 * - a TRANSPORT failure ({@link isTransportFailure}) -> `unreachable`. NEVER a login redirect: nothing
 *   answered, so "you are signed out" would be a lie, and nothing here logs anyone out. A status
 *   code is an answer, a transport failure is not.
 *
 * `unreachable` is derived from the failure event itself - the refresh's own deadline or transport
 * error - never from a second timer. It ends on a retry the user asks for, or on the browser's
 * `online` event.
 */

import { isTransportFailure } from '$lib/utils/transportFailure';
import { isSignedOutPath } from '$lib/utils/internalPath';

/** `settled`: the question is answered (or was never asked). */
export type BootSessionPhase = 'settled' | 'resolving' | 'unreachable';

/** What the boot needs from the outside - injected so the decision is testable without the stores. */
export interface BootSessionDeps {
  /** The silent refresh (it restores the user id from the token on success). */
  refresh: () => Promise<unknown>;
  /** The locally known user id, or null. */
  currentUserId: () => string | null;
  /** Sends the user to the login screen, carrying the page they were going to. */
  goToLogin: () => Promise<unknown> | void;
  /** Runs once the session is known (the background profile check). */
  onSessionKnown: (userId: string) => void;
}

let phase = $state<BootSessionPhase>('settled');
let inFlight: Promise<void> | null = null;
let lastDeps: BootSessionDeps | null = null;
let removeOnline: (() => void) | null = null;

const blog = (msg: string) => console.log('[boot] ' + msg);
const bwarn = (msg: string) => console.warn('[boot] ' + msg);

/** The current phase of the boot's session question. */
export function bootSessionPhase(): BootSessionPhase {
  return phase;
}

/**
 * True when the page must not be drawn yet: the session question is open (or unanswerable) and the
 * route is not one a visitor without an account may read.
 */
export function bootSessionBlocks(pathname: string): boolean {
  return phase !== 'settled' && !isSignedOutPath(pathname);
}

function dropOnlineListener(): void {
  removeOnline?.();
  removeOnline = null;
}

/** Ends the question without asking (a user id is known, or the route needs no session). */
export function settleBootSession(): void {
  dropOnlineListener();
  phase = 'settled';
}

/**
 * The question itself. It reads {@link lastDeps} at every step, never the deps it was started with:
 * a link opened during the boot (a Tauri deep link) navigates, the root load re-runs and hands over
 * fresh deps, and the login redirect must carry THAT page, not the first one.
 */
async function run(): Promise<void> {
  const deps = (): BootSessionDeps => lastDeps!;
  try {
    let userId = deps().currentUserId();
    if (!userId) {
      blog(
        'no stored user - asking the server for the session; the screen shows the boot state meanwhile'
      );
      try {
        await deps().refresh();
      } catch (e) {
        // A sign-in may have completed while the request was in flight: it answers the question.
        if (!deps().currentUserId() && isTransportFailure(e)) {
          bwarn(`session question unanswered, nothing reached the server: ${String(e)}`);
          phase = 'unreachable';
          if (typeof window !== 'undefined') {
            const onOnline = () => retryBootSession();
            window.addEventListener('online', onOnline, { once: true });
            removeOnline = () => window.removeEventListener('online', onOnline);
          }
          return;
        }
        blog(`refresh refused (${e instanceof Error ? e.name : typeof e}) - no session`);
      }
      userId = deps().currentUserId();
    }
    if (!userId) {
      try {
        await deps().goToLogin();
      } catch (e) {
        bwarn(`redirect to login failed: ${String(e)}`);
      }
      settleBootSession();
      return;
    }
    settleBootSession();
    deps().onSessionKnown(userId);
  } catch (e) {
    bwarn(`the session question failed unexpectedly: ${String(e)}`);
  } finally {
    // NEVER LEAVE `resolving` BEHIND: only an explicit `unreachable` outlives the run.
    if (phase === 'resolving') settleBootSession();
  }
}

/**
 * Ends the question because a session is known by another road (another caller's refresh succeeded,
 * the unlock completed): nothing is left to ask, and `unreachable` would be stale.
 */
export function noteSessionKnownElsewhere(): void {
  if (phase === 'settled') return;
  blog('a session is known by another road - the boot question is over');
  settleBootSession();
}

/**
 * Starts the session question and returns at once. Idempotent: a navigation during the question
 * joins the one in flight.
 */
export function startBootSession(deps: BootSessionDeps): void {
  lastDeps = deps;
  if (inFlight) return;
  dropOnlineListener();
  phase = 'resolving';
  inFlight = run().finally(() => {
    inFlight = null;
  });
}

/** Asks again after an `unreachable` verdict (the retry button, the `online` event). */
export function retryBootSession(): void {
  if (phase !== 'unreachable' || !lastDeps) return;
  blog('retrying the session question');
  startBootSession(lastDeps);
}

/** Test seam: back to the module's initial state. */
export function resetBootSessionForTest(): void {
  dropOnlineListener();
  phase = 'settled';
  inFlight = null;
  lastDeps = null;
}
