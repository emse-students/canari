import { m } from '$lib/paraglide/messages';
import {
  SessionEndedByDeviceRevocationError,
  SessionExpiredError,
  TransientAnswerError,
} from '$lib/stores/auth';
import { refusalOrigin } from '$lib/utils/apiJson';
import { ServerUnreachableError, isServerUnreachable } from '$lib/utils/fetchOrUnreachable';
import { LocalizedError } from '$lib/utils/localizedError';
import { isTransportFailure } from '$lib/utils/transportFailure';
import {
  LoginFailure,
  loginErrorCode,
  noKeypadNoticeFor,
  type LoginErrorCode,
} from './loginErrors';

/**
 * A 401 OR 403 FROM A PIN ROUTE, WRITTEN BY OUR OWN SERVICE, IS AN ANSWER: THE SESSION THE REQUEST
 * CARRIED WAS REFUSED. It is not "server unreachable" (1.7.3-alpha.6, dev, 2026-11-22). A device
 * removed from the account through another device while it sat at the PIN gate answered
 * `GET pin-salt` 401 twice, and the `!res.ok` branch worded both as "Serveur injoignable" under an
 * ordinary keypad - so the person retyped a PIN into a session that could never accept it.
 *
 * Classified HERE, at the throw, as a type: whoever catches it asks the server WHY the session was
 * refused ({@link settlePinSessionRefusal}) and never reads the sentence. It IS a
 * {@link LocalizedError} so a caller that does not settle it still shows a truthful "the server could
 * not verify your PIN" rather than the unreachable text.
 */
export class PinSessionRefusedError extends LocalizedError {
  constructor(
    /** The PIN route that refused (`pin-salt`, `pin-check`), for the log. */
    readonly route: string,
    /** The status it answered: 401 or 403. */
    readonly status: number
  ) {
    super(m.auth_pin_check_unexpected());
    this.name = 'PinSessionRefusedError';
  }
}

/**
 * Throws on a 401/403 from a PIN route; returns otherwise.
 *
 * ONLY OUR OWN SERVICE'S REFUSAL IS A VERDICT ON THE SESSION (`refusalOrigin`, the rule `refresh`
 * applies to its own 401/403): a WAF ban page or a captive portal answers 401/403 too and says
 * nothing about the credential, so it ends as {@link ServerUnreachableError} with the caller's own
 * `unreachable` line - the network path failed, not the session.
 */
export async function throwIfPinSessionRefused(
  res: Response,
  route: string,
  unreachable: string
): Promise<void> {
  if (res.status !== 401 && res.status !== 403) return;
  if ((await refusalOrigin(res)) === 'gateway') throw new PinSessionRefusedError(route, res.status);
  throw new ServerUnreachableError(
    unreachable,
    new Error(`${route} answered ${res.status} from the edge`)
  );
}

/** What {@link settlePinSessionRefusal} needs, injected so every verdict can be driven by a test. */
export interface PinSessionRefusalDeps {
  /**
   * Asks the server whether the session is alive, WITHOUT announcing a dead one (the gate owns the
   * outcome): resolves when it is, rejects with the typed verdict when it is not.
   */
  askSession: () => Promise<unknown>;
  /**
   * The error `askSession` rejected with, read as "this session ended BECAUSE ITS OWNER REMOVED THIS
   * DEVICE" - and the device reset run, answering `true` once it has. `false` for every other end.
   */
  settleRevocation: (verdict: unknown) => Promise<boolean>;
  /** False once nobody is listening for the outcome (the login aborted, the account signed out). */
  stillListening: () => boolean;
  /** Announces the verdict the hold kept back; called only when `stillListening` is false. */
  releaseVerdict: () => void;
  /** The line a transport failure while asking ends with (the caller's own unreachable text). */
  unreachable: string;
  log: (msg: string) => void;
}

/**
 * THE ANSWER TO "WHY WAS MY SESSION REFUSED" THAT IS NOT AN ANSWER: a transport failure or a
 * non-verdict status of the renewal (`TransportFailureError`, `RequestDeadlineError`,
 * `TransientAnswerError`: a 5xx, 408, 429 or an edge page). Typed here, at the seam, as
 * {@link ServerUnreachableError} with the rejection kept as its cause - nothing was learned about the
 * session, so the gate shows its retryable "unreachable" line and nothing is accused.
 */
function unreachableOfSettle(e: unknown, unreachable: string): Error | null {
  if (isServerUnreachable(e)) return e as Error;
  if (isTransportFailure(e) || e instanceof TransientAnswerError) {
    return new ServerUnreachableError(unreachable, e);
  }
  return null;
}

/**
 * The outcome of a PIN route refusing the session: what to throw, never a sentence to show.
 *
 * - the server says the session ended because this device was removed: the device is reset and the
 *   outcome is `device_revoked`, which the gate shows as its no-keypad state (`noKeypadNoticeFor`);
 * - the session ended for any other reason: the verdict itself (`SessionExpiredError`), which the
 *   login's catch answers by signing out - the same path every dead session takes;
 * - the question could not be answered (transport failure, deadline, a non-verdict status):
 *   {@link ServerUnreachableError} - a 401 followed by a dead link says nothing about the device;
 * - the session is ALIVE (it refreshed): the refusal is unexplained, so it is said as unexpected and
 *   accused (`other`), never retried here.
 *
 * When nobody is listening any more, the verdict the hold kept back is announced (`releaseVerdict`),
 * so it never reaches nobody.
 */
export async function settlePinSessionRefusal(
  refusal: PinSessionRefusedError,
  deps: PinSessionRefusalDeps
): Promise<Error> {
  deps.log(
    `[PIN] ${refusal.route} answered ${refusal.status} - the session was refused; asking the server why.`
  );
  let outcome: Error;
  // DECIDED WHEN THE ANSWER ARRIVES, before the reset below: the login's own revocation wipe signs the
  // account out on purpose, and reading `stillListening` after it would call that sign-out a login that
  // left and announce a verdict nobody lost.
  let listening = true;
  try {
    await deps.askSession();
    listening = deps.stillListening();
    deps.log(
      `[PIN] ${refusal.route} refused a session the server says is alive - nothing explains it.`
    );
    outcome = new LoginFailure('other', m.auth_pin_check_unexpected());
  } catch (verdict: unknown) {
    listening = deps.stillListening();
    const unreachable = unreachableOfSettle(verdict, deps.unreachable);
    if (unreachable) {
      deps.log(
        `[PIN] The session question could not be answered (${String(verdict)}) - unreachable.`
      );
      outcome = unreachable;
    } else if (await deps.settleRevocation(verdict)) {
      deps.log("[SECURITY] The refusal is this device's removal from the account - reset done.");
      outcome = new LoginFailure('device_revoked', m.auth_device_revoked_reset());
    } else {
      outcome = verdict instanceof Error ? verdict : new Error(String(verdict));
    }
  }
  if (!listening) {
    deps.log(
      '[PIN] The login stopped while the session question was open - releasing its verdict.'
    );
    deps.releaseVerdict();
  }
  return outcome;
}

/** What {@link settleRevocationOfThisDevice} reads and does, injected for a behavioural test. */
export interface RevocationOfThisDeviceDeps {
  /** The account whose gate this is. */
  userId: string;
  /** This install's stored device id for the account, or `null` when it holds none. */
  storedDeviceId: () => string | null;
  /** Throws when the account signed out meanwhile. */
  stopIfSignedOut: () => void;
  /** Withdraws the login from the abort the wipe's own sign-out will raise. */
  startOwnWipe: () => void;
  /** The ONE revocation reset; `true` once it ran. */
  wipe: () => Promise<boolean>;
}

/**
 * Resets this device when - and ONLY when - the refusal says the session ended by the revocation of
 * THIS device of THIS account. A revocation naming another device, another account, or an id this
 * install has since rotated away from is a plain dead session that keeps every store: a destructive
 * reset is gated on the fact that names this device, never on "a revocation happened".
 */
export async function settleRevocationOfThisDevice(
  verdict: unknown,
  deps: RevocationOfThisDeviceDeps
): Promise<boolean> {
  if (!(verdict instanceof SessionEndedByDeviceRevocationError)) return false;
  const mine = deps.storedDeviceId();
  if (mine === null || !verdict.names(deps.userId, mine)) return false;
  deps.stopIfSignedOut();
  deps.startOwnWipe();
  return deps.wipe();
}

/** Where a failed PIN recovery goes next: the one route the login's own outcomes take. */
export type RecoveryFailureRoute =
  | { kind: 'session-expired' }
  | { kind: 'removed'; code: LoginErrorCode }
  | null;

/**
 * Routes a failure of the PIN recovery the way the login routes it: a dead session goes to the
 * app-wide session-expired reaction (sign-out, redirect - the verdict the recovery held is its to
 * answer, never "recovery failed" with a session left dead), and a device removed from the account
 * to the gate's no-keypad state. `null` for every other failure, which the modal words itself.
 */
export function routeOfRecoveryFailure(e: unknown): RecoveryFailureRoute {
  if (e instanceof SessionExpiredError) return { kind: 'session-expired' };
  const code = loginErrorCode(e);
  return noKeypadNoticeFor(code) ? { kind: 'removed', code } : null;
}
