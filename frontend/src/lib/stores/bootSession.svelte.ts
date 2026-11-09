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
 * - a VERDICT that is not a token (the app's own 401/403, an app-origin 4xx such as a 404 in Nest's
 *   envelope, an identity split, ...) -> login, then `settled`;
 * - NO VERDICT ({@link isSessionQuestionOpen}): nobody answered (a transport failure, a deadline, a
 *   captive portal's `200 text/html`), or the answer was a `TransientAnswerError` - a 5xx (the 503
 *   `MAINTENANCE` included), a 408 or 429, or anything the edge wrote (a WAF's HTML 403) ->
 *   `unreachable`, with its {@link BootUnreachableCause} so the screen blames the right party. NEVER
 *   a login redirect: the credential was not judged, so "you are signed out" would be a lie, and
 *   nothing here logs anyone out.
 *
 * `unreachable` is derived from the failure event itself - the refresh's own deadline, transport
 * error or non-verdict answer - never from a second timer. It ends on a retry the user asks for, or on the browser's
 * `online` event.
 */

import { isSessionQuestionOpen, TransientAnswerError } from '$lib/utils/transportFailure';
import { isSignedOutPath } from '$lib/utils/internalPath';

/** `settled`: the question is answered (or was never asked). */
export type BootSessionPhase = 'settled' | 'resolving' | 'unreachable';

/**
 * WHY the question stayed open, read from the failure's TYPE and fields (never its message), so the
 * screen does not blame the network for a server that answered:
 * - `network`: nobody answered, or the EDGE refused the path (a WAF ban page) - this network;
 * - `server`: the server (or the edge in front of it) answered a 5xx, a 408 or a 429;
 * - `maintenance`: core-service's 503 `MAINTENANCE` (the platform switch).
 */
export type BootUnreachableCause = 'network' | 'server' | 'maintenance';

/** The cause of a failure {@link isSessionQuestionOpen} already accepted. */
function unreachableCauseOf(error: unknown): BootUnreachableCause {
  if (!(error instanceof TransientAnswerError)) return 'network';
  // A code alone proves nothing about the switch: only core-service's 503 carries it.
  if (error.code === 'MAINTENANCE' && error.status === 503) return 'maintenance';
  if (error.status >= 500 || error.status === 408 || error.status === 429) return 'server';
  return 'network';
}

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
let cause = $state<BootUnreachableCause>('network');
let maintenanceText = $state<string | null>(null);
let inFlight: Promise<void> | null = null;
let lastDeps: BootSessionDeps | null = null;
let removeOnline: (() => void) | null = null;

const blog = (msg: string) => console.log('[boot] ' + msg);
const bwarn = (msg: string) => console.warn('[boot] ' + msg);

/** The current phase of the boot's session question. */
export function bootSessionPhase(): BootSessionPhase {
  return phase;
}

/** Why the phase is `unreachable` (meaningless in the other phases). */
export function bootUnreachableCause(): BootUnreachableCause {
  return cause;
}

/** The operator's maintenance text when the cause is `maintenance` and one was set, else null. */
export function bootMaintenanceMessage(): string | null {
  return maintenanceText;
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
        if (!deps().currentUserId() && isSessionQuestionOpen(e)) {
          cause = unreachableCauseOf(e);
          maintenanceText =
            cause === 'maintenance' && e instanceof TransientAnswerError
              ? e.maintenanceMessage
              : null;
          bwarn(`session question unanswered (cause ${cause}, no verdict): ${String(e)}`);
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
  cause = 'network';
  maintenanceText = null;
  inFlight = null;
  lastDeps = null;
}
