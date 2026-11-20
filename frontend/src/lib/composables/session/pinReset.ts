import type { AtRestKeyScheme } from '$lib/crypto/hardwareHeldKey';
import { pinServerRequest, type PinTransport } from './pinServer';
import { restartsAsNewDevice, type LoginErrorCode } from './loginErrors';

/**
 * The "forgot PIN" reset's ORDER, which is its whole mechanism (rounds 6 to 10 of the review of #2919).
 *
 * 0. `serverSaltFingerprint` - the server's salt NOW, the basis the stage journals. No answer: nothing
 *    is moved and the server is not asked. No PIN on the server: there is nothing to reset there, so
 *    the local state is reset alone - staged and committed at once, logged (round 10).
 * 1. `stage` - the account's local MLS state is SET APART, never removed, once a signed-out session's
 *    final checkpoint has landed. Refused: nothing moved, and the server is NOT asked.
 * 2. `askServer` - the server resets the PIN. A DEFINITE REFUSAL (a 4xx, {@link PinResetRefusedError}):
 *    `rollback` puts the state back, so the old PIN still opens it. ANYTHING ELSE - a transport failure,
 *    a 5xx - is NO ANSWER, never read as a refusal: the server may have reset the PIN and lost its
 *    reply. It is decided like a page that is gone, by the salt: the same salt rolls back, none or
 *    another goes on to the commit, and a salt the server will not say either hands the reset over to
 *    the settle every sign-in attempt runs (`handOver`), the failure propagated.
 * 3. `enterFirstSetup` - the moment the server has reset the PIN, before anything else can fail: the
 *    old PIN opens nothing any more, so the next PIN typed must be read as a NEW one, never as an
 *    unlock - which would meet no state and be misread as a PIN rotated elsewhere.
 * 4. `commit` - what was set apart is removed with the account's local session. A failure here
 *    propagates with the gate already in first setup.
 *
 * Before, the server was asked first and the local state removed after, its refusal checked earlier
 * still - with a sign-out's final checkpoint free to land between the check and the removal.
 */
export interface PinResetSteps {
  /** {@link serverPinSaltFingerprint} for the account; throws when the server does not answer. */
  serverSaltFingerprint: () => Promise<string | null>;
  stage: (serverBasis: string) => Promise<void>;
  askServer: () => Promise<void>;
  rollback: () => Promise<void>;
  /** Hands this page's staged reset over to the settle of the next sign-in attempt. */
  handOver: () => Promise<void>;
  enterFirstSetup: () => void;
  commit: () => Promise<void>;
  log: (msg: string) => void;
}

/**
 * The server REFUSED the reset - a 4xx: it answered, and it did nothing. The only failure of
 * `askServer` that may roll the stage back on its own; every other one is no answer.
 */
export class PinResetRefusedError extends Error {
  constructor(readonly status: number) {
    super(`Server-side PIN reset refused (${status}).`);
    this.name = 'PinResetRefusedError';
  }
}

/**
 * The basis a reset staged with NO PIN on the server journals: the fingerprint of an empty salt, which
 * no salt the server mints ever has. A settle of it reads "no PIN" or "another salt" - a commit, as
 * the stage meant.
 */
export async function noServerPinBasis(): Promise<string> {
  return pinSaltFingerprint('');
}

/** Rolls the stage back, a failure said and left to the next sign-in's settle. */
async function rollBack(steps: PinResetSteps): Promise<void> {
  try {
    await steps.rollback();
  } catch (r) {
    // Not lost: the reset stays journalled, and the next sign-in settles it from the server's
    // answer - which says the PIN was not reset, so it is put back ({@link settleUnsettledPinReset}).
    steps.log(
      `[PIN_RESET] ERROR: the local state could not be put back now - the next sign-in puts it back: ${String(r)}`
    );
  }
}

/** Runs the reset's steps in their order - see {@link PinResetSteps}. */
export async function runPinReset(steps: PinResetSteps): Promise<void> {
  const basis = await steps.serverSaltFingerprint();
  if (basis === null) {
    steps.log(
      '[PIN_RESET] the server holds no PIN for this account - nothing to reset there, the local state is reset alone'
    );
    await steps.stage(await noServerPinBasis());
    steps.enterFirstSetup();
    await steps.commit();
    steps.log('[PIN_RESET] MLS state wiped - choose a new PIN.');
    return;
  }
  steps.log('[PIN_RESET] setting the local MLS state apart');
  await steps.stage(basis);
  try {
    await steps.askServer();
  } catch (e) {
    if (e instanceof PinResetRefusedError) {
      steps.log(
        `[PIN_RESET] the server refused the reset - the local state is put back: ${e.message}`
      );
      await rollBack(steps);
      throw e;
    }
    // NO ANSWER IS NOT A REFUSAL: decided by the salt, as a page that is gone is.
    steps.log(
      `[PIN_RESET] the server did not answer the reset - whether it reset the PIN is read from its salt: ${String(e)}`
    );
    let now: string | null;
    try {
      now = await steps.serverSaltFingerprint();
    } catch (f) {
      steps.log(
        `[PIN_RESET] ERROR: the server does not say whether it reset the PIN - the reset stays unsettled, settled at the next sign-in attempt online: ${String(f)}`
      );
      await steps.handOver();
      throw e;
    }
    if (now === basis) {
      steps.log(
        '[PIN_RESET] the salt is unchanged - the server did not reset the PIN, the local state is put back'
      );
      await rollBack(steps);
      throw e;
    }
    steps.log(
      '[PIN_RESET] the salt is gone or changed - the server reset the PIN, its answer was lost'
    );
  }
  steps.enterFirstSetup();
  steps.log('[PIN_RESET] the server reset the PIN - the gate now asks for a new one');
  await steps.commit();
  steps.log('[PIN_RESET] MLS state wiped - choose a new PIN.');
}

/**
 * The fingerprint of a PIN salt as a staged reset journals it: SHA-256, 64 lowercase hex digits. The
 * salt is the SERVER'S fact the reset changes - `pin-reset` deletes the row that holds it, and a new
 * PIN chosen since writes a new one - so its fingerprint before the ask, compared with the server's
 * salt later, says whether the PIN was reset.
 */
export async function pinSaltFingerprint(salt: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(salt))
  );
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** How the server is reached for {@link serverPinSaltFingerprint}. */
export interface PinServer {
  /** The chat-delivery base URL (`deliveryUrl()`). */
  baseUrl: string;
  /** A live access token. */
  token: string;
  /** A test's transport; absent, {@link pinServerRequest}'s own, under the request deadline. */
  fetchFn?: PinTransport;
}

/**
 * The fingerprint of `userId`'s PIN salt on the server NOW ({@link pinSaltFingerprint}), or `null`
 * when the server holds no PIN for it. THROWS when the server does not answer - "unknown" is never
 * read as either answer.
 *
 * `pin-status` FIRST: `GET pin-salt` WRITES for a user with no salt (it creates the placeholder row),
 * so it is asked only of a user the server says has one.
 */
export async function serverPinSaltFingerprint(
  userId: string,
  { baseUrl, token, fetchFn }: PinServer
): Promise<string | null> {
  // Under the request deadline (`pinServerRequest`, PIN audit row 11): no answer is "unknown".
  const init = { headers: { Authorization: `Bearer ${token}` } };
  const status = await pinServerRequest({ baseUrl, route: 'pin-status', userId, init }, fetchFn);
  if (!status.ok) throw new Error(`pin-status answered ${status.status}`);
  const { registered } = (await status.json()) as { registered: unknown };
  if (typeof registered !== 'boolean') throw new Error('pin-status answered no registered flag');
  if (!registered) return null;
  const res = await pinServerRequest({ baseUrl, route: 'pin-salt', userId, init }, fetchFn);
  if (!res.ok) throw new Error(`pin-salt answered ${res.status}`);
  const { salt } = (await res.json()) as { salt: unknown };
  if (typeof salt !== 'string' || salt.length === 0) throw new Error('pin-salt answered no salt');
  return pinSaltFingerprint(salt);
}

/**
 * The steps of {@link settleUnsettledPinReset}, injected so the decision is tested on its own.
 */
export interface UnsettledPinResetSteps {
  /** Adopts the account's unsettled reset for this page: its server basis, `null` for none. */
  adopt: () => Promise<string | null>;
  /** {@link serverPinSaltFingerprint} for the account; throws when the server does not answer. */
  serverSaltFingerprint: () => Promise<string | null>;
  /** The server reset the PIN: what was set apart is removed, as the reset's own commit does. */
  commit: () => Promise<void>;
  /** The server did not: the stage is undone, so the old PIN still opens the state. */
  rollback: () => Promise<void>;
  log: (msg: string) => void;
}

/**
 * What {@link settleUnsettledPinReset} did. A commit says what the server holds now (round 10): no
 * PIN (`committed`) - the gate opens in first setup, as after the reset's own commit - or ANOTHER one
 * (`committed_pin_chosen`), chosen since on another device - the gate asks for it as an unlock.
 */
export type UnsettledPinResetOutcome =
  | 'none'
  | 'committed'
  | 'committed_pin_chosen'
  | 'rolled_back'
  | 'unanswered';

/**
 * ONE SETTLE PER ACCOUNT AT A TIME, in one page (round 11 of the review of #2919): the sign-in flow
 * settles before any unlock, and the gate's failure handler settles again on `pin_reset_unsettled` -
 * two settles of one reset would race their commit and rollback. A call while one runs for the same
 * account JOINS it (same promise, logged); the next call after it ends starts a new one, so a retry
 * once the network is back still asks the server.
 */
export function oneSettlePerAccount<T>(
  log: (msg: string) => void
): (account: string, settle: () => Promise<T>) => Promise<T> {
  const inFlight = new Map<string, Promise<T>>();
  return (account, settle) => {
    const running = inFlight.get(account);
    if (running) {
      log('[PIN_RESET] a settle of this account already runs - this call joins it');
      return running;
    }
    const started = settle().finally(() => inFlight.delete(account));
    inFlight.set(account, started);
    return started;
  };
}

/**
 * SETTLES A "FORGOT PIN" RESET A PAGE THAT IS GONE LEFT UNSETTLED, FROM THE SERVER'S ANSWER (round 9
 * of the review of #2919), at the start of every sign-in flow. Round 8 undid every such reset - and a
 * reload AFTER the server reset the PIN sent the account back to an old PIN that opens nothing, the
 * loop the reset exists to leave.
 *
 * - No PIN on the server, or a salt whose fingerprint differs from the one journalled at the stage:
 *   the server reset the PIN (and a new one may have been chosen since) - COMMIT.
 * - The same salt: the server did not reset it - ROLL BACK.
 * - No answer: nothing is guessed. The reset stays ADOPTED, the account's sign-in stays refused
 *   natively (`RESET_UNSETTLED`), and the next attempt - of this page too: an adopted reset is
 *   adopted again - asks again (round 10).
 */
export async function settleUnsettledPinReset(
  steps: UnsettledPinResetSteps
): Promise<UnsettledPinResetOutcome> {
  const basis = await steps.adopt();
  if (basis === null) return 'none';
  steps.log("[PIN_RESET] a reset left by a page that is gone is settled from the server's answer");
  let now: string | null;
  try {
    now = await steps.serverSaltFingerprint();
  } catch (e) {
    steps.log(
      `[PIN_RESET] ERROR: the server did not say whether the PIN was reset - the reset stays unsettled, and this account's sign-in refused until it answers: ${String(e)}`
    );
    return 'unanswered';
  }
  if (now === basis) {
    await steps.rollback();
    steps.log('[PIN_RESET] the server did not reset the PIN - the local state is put back');
    return 'rolled_back';
  }
  await steps.commit();
  steps.log(
    `[PIN_RESET] the server reset the PIN (${now === null ? 'no PIN registered' : 'another salt'}) - the reset is committed`
  );
  return now === null ? 'committed' : 'committed_pin_chosen';
}

/**
 * Whether a failed unlock restarts THIS DEVICE as a new device of the account, and why not when it
 * does not. `automatic` is the owner's decision of 2026-11-20 for a hardware-held key PROVEN gone
 * (`restartsAsNewDevice`): no error, no button. `none` covers every other code, the unreadable key
 * above all - it may still exist. `withheld_other_account`: this install's state is proven to be
 * another account's, and nothing of that account is ever deleted from this one's session.
 * `already_restarted`: this page restarted the account once already and met the same refusal again,
 * so a second restart could only loop - the proof that ends it, accused by the caller.
 */
export type DeviceRestartDecision =
  | 'automatic'
  | 'none'
  | 'withheld_other_account'
  | 'already_restarted';

/** Decides {@link DeviceRestartDecision} from the typed code and the two facts that withhold it. */
export function decideAutomaticRestart(
  code: LoginErrorCode | undefined,
  facts: { otherAccountState: boolean; alreadyRestarted: boolean }
): DeviceRestartDecision {
  if (!restartsAsNewDevice(code)) return 'none';
  if (facts.otherAccountState) return 'withheld_other_account';
  if (facts.alreadyRestarted) return 'already_restarted';
  return 'automatic';
}

/** The local half of the "forgot PIN" reset, which {@link runDeviceRestart} reuses. */
export interface DeviceRestartSteps {
  /** The forgot-PIN reset's `stage`: sets the account's local MLS state apart. */
  stage: (serverBasis: string) => Promise<void>;
  /** The forgot-PIN reset's `commit`: removes what was set apart, with the account's local records. */
  commit: () => Promise<void>;
  /**
   * This account's at-rest scheme as the DISK holds it now (`cle_au_repos_schema`), read once the
   * commit returned; `pin-derived` on a build with no hardware-held key.
   */
  atRestScheme: () => Promise<AtRestKeyScheme>;
  log: (msg: string) => void;
}

/**
 * A restart whose commit returned while the disk still names a hardware-held key: the erase it
 * reports did not happen (a database that would not clear keeps the marker, and a marker that would
 * not be forgotten stays). Unlocking again would meet the same lost key, so nothing is retried.
 */
export class DeviceRestartUnfinishedError extends Error {
  constructor(readonly scheme: AtRestKeyScheme) {
    super(`the device restart did not complete - the at-rest marker still reads "${scheme}"`);
    this.name = 'DeviceRestartUnfinishedError';
  }
}

/**
 * RESTARTS THIS DEVICE AS A NEW DEVICE OF THE ACCOUNT: the forgot-PIN reset's local half, and ONLY
 * that half. The server is never asked to reset the PIN - `pin-reset` deletes the account's verifier
 * and purges EVERY device, the ones that still hold the history this device gets back from. The PIN
 * the person holds stays the account's, and the next unlock enrols this device afresh.
 *
 * Staged under {@link noServerPinBasis}, as a reset with no PIN on the server is: a page cut between
 * the stage and the commit leaves a journalled reset that the next sign-in's settle COMMITS (no salt
 * the server mints has that fingerprint), never one it puts back - the state set apart opens under no
 * key, so putting it back would only meet the same refusal again.
 *
 * THE END STATE IS READ FROM THE DISK, NEVER TAKEN FROM THE COMMIT. The commit swallows a database
 * that would not clear and a marker that would not be forgotten (each logged), so "it returned" is
 * not "it erased". Anything but `pin-derived` afterwards throws {@link DeviceRestartUnfinishedError}.
 */
export async function runDeviceRestart(steps: DeviceRestartSteps): Promise<void> {
  steps.log(
    '[DEVICE_RESTART] setting the local MLS state apart - the server PIN is left untouched'
  );
  await steps.stage(await noServerPinBasis());
  await steps.commit();
  const scheme = await steps.atRestScheme();
  if (scheme !== 'pin-derived') throw new DeviceRestartUnfinishedError(scheme);
  steps.log('[DEVICE_RESTART] local MLS state removed - the next unlock enrols a new device');
}
