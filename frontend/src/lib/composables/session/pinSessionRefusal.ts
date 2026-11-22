import { m } from '$lib/paraglide/messages';
import { LocalizedError } from '$lib/utils/localizedError';
import { LoginFailure } from './loginErrors';

/**
 * A 401 OR 403 FROM A PIN ROUTE IS AN ANSWER: THE SESSION THE REQUEST CARRIED WAS REFUSED. It is not
 * "server unreachable" (1.7.3-alpha.6, dev, 2026-11-22). A device removed from the account through
 * another device while it sat at the PIN gate answered `GET pin-salt` 401 twice, and the `!res.ok`
 * branch worded both as "Serveur injoignable" under an ordinary keypad - so the person retyped a PIN
 * into a session that could never accept it.
 *
 * Classified HERE, at the throw, as a type: whoever catches it asks the server WHY the session was
 * refused ({@link settlePinSessionRefusal}) and never reads the sentence. It IS a
 * {@link LocalizedError} so a caller that does not settle it (the PIN recovery) still shows a
 * truthful "the server could not verify your PIN" rather than the unreachable text.
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

/** Throws {@link PinSessionRefusedError} when `res` is a 401 or 403; returns otherwise. */
export function throwIfPinSessionRefused(res: Response, route: string): void {
  if (res.status === 401 || res.status === 403) throw new PinSessionRefusedError(route, res.status);
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
  log: (msg: string) => void;
}

/**
 * The outcome of a PIN route refusing the session: what to throw, never a sentence to show.
 *
 * - the server says the session ended because this device was removed: the device is reset and the
 *   outcome is `device_revoked`, which the gate shows as its no-keypad state (`noKeypadNoticeFor`);
 * - the session ended for any other reason: the verdict itself (`SessionExpiredError`), which the
 *   login's catch answers by signing out - the same path every dead session takes;
 * - the question could not be asked (a transport failure): that rejection, which is `unreachable` and
 *   nothing else - a 401 followed by a dead link says nothing about the device;
 * - the session is ALIVE (it refreshed): the refusal is unexplained, so it is said as unexpected and
 *   accused (`other`), never retried here.
 */
export async function settlePinSessionRefusal(
  refusal: PinSessionRefusedError,
  deps: PinSessionRefusalDeps
): Promise<Error> {
  deps.log(
    `[PIN] ${refusal.route} answered ${refusal.status} - the session was refused; asking the server why.`
  );
  try {
    await deps.askSession();
  } catch (verdict: unknown) {
    if (await deps.settleRevocation(verdict)) {
      deps.log("[SECURITY] The refusal is this device's removal from the account - reset done.");
      return new LoginFailure('device_revoked', m.auth_device_revoked_reset());
    }
    return verdict instanceof Error ? verdict : new Error(String(verdict));
  }
  deps.log(
    `[PIN] ${refusal.route} refused a session the server says is alive - nothing explains it.`
  );
  return new LoginFailure('other', m.auth_pin_check_unexpected());
}
