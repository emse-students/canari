/**
 * The "forgot PIN" reset's ORDER, which is its whole mechanism (round 6 of the review of #2919).
 *
 * 1. `stage` - the account's local MLS state is SET APART, never removed, once a signed-out session's
 *    final checkpoint has landed. Refused: nothing moved, and the server is NOT asked.
 * 2. `askServer` - the server resets the PIN. Refused or unreachable: `rollback` puts the state back,
 *    so the old PIN still opens it, and the failure propagates.
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
  stage: () => Promise<void>;
  askServer: () => Promise<void>;
  rollback: () => Promise<void>;
  enterFirstSetup: () => void;
  commit: () => Promise<void>;
  log: (msg: string) => void;
}

/** Runs the reset's steps in their order - see {@link PinResetSteps}. */
export async function runPinReset(steps: PinResetSteps): Promise<void> {
  steps.log('[PIN_RESET] setting the local MLS state apart');
  await steps.stage();
  try {
    await steps.askServer();
  } catch (e) {
    steps.log(
      `[PIN_RESET] the server did not reset the PIN - the local state is put back: ${String(e)}`
    );
    try {
      await steps.rollback();
    } catch (r) {
      // Not lost: a state set apart that no reset of this process owns is put back at the next
      // look (`settle_pending_moves_held`).
      steps.log(
        `[PIN_RESET] ERROR: the local state could not be put back now - it is at the next start: ${String(r)}`
      );
    }
    throw e;
  }
  steps.enterFirstSetup();
  steps.log('[PIN_RESET] the server reset the PIN - the gate now asks for a new one');
  await steps.commit();
  steps.log('[PIN_RESET] MLS state wiped - choose a new PIN.');
}
