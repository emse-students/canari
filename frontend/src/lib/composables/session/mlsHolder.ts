import type { IMlsService } from '$lib/mls-client';
import type { NativeMlsSessionEnd } from '$lib/utils/nativeMlsSession';

/**
 * The session's MLS client, and the one rule for letting go of it at a sign-out.
 *
 * A SIGNED-OUT ACCOUNT'S CLIENT MUST NOT SERVE THE NEXT SIGN-IN. `BaseMlsService.init` returns at
 * once once it has run (`initPromise`), and `resolveDeviceId` hands back the id it cached, so a
 * client kept across a sign-out made account B's login run on account A's decrypted state and A's
 * device id - which B would then have bound to its own session. Nothing called `resetMls` on that
 * path, and until 2026-10-14 nothing noticed, because a sign-out never ended the session at all.
 *
 * RETIRING IS TWO STEPS WITH DIFFERENT TIMES. The holder lets go AT ONCE, so any caller from then on
 * builds a fresh client for whoever signs in next; the old client is destroyed only once its FINAL
 * CHECKPOINT has landed, because that write is what the next login reads from the disk - opening the
 * state while it is still being written would start an account one epoch behind what its peers hold.
 * So a login waits for {@link MlsHolder.whenRetired} before it opens anything. The same account
 * signing back in pays one state decrypt for it, as a cold start does: correctness first.
 */
export interface MlsHolder {
  /** The current client, created on first use. */
  ensure(): IMlsService;
  /**
   * Destroys the current client now (a failed login, a revoked device). With `only`, does so only
   * when `only` IS the current client: a login stopped by a sign-out releases the client it built,
   * never one the next sign-in has built since the sign-out retired it.
   */
  reset(only?: IMlsService): void;
  /**
   * Lets go of the current client now and destroys it once `finalWrite` settles. `finalWrite` must
   * never reject: it is the teardown's flush, which reports its own failure. `why` names the end in
   * the native log: a sign-out unless the session was lost (`endLostSessionImpl`).
   */
  retire(finalWrite: Promise<void>, why?: 'sign-out' | 'lost session'): Promise<void>;
  /** Settles once every retired client's final write has landed and the client is destroyed. */
  whenRetired(): Promise<void>;
  /** True while a retired client's final write is still in flight. */
  isRetiring(): boolean;
}

/**
 * Builds the holder over `create`, the platform's client factory, and `endNative`, which ends what the
 * platform holds natively for the client let go of (`endNativeMlsSession`).
 *
 * **THE NATIVE SESSION ENDS WITH THE CLIENT, AND IN THE CHAIN A LOGIN WAITS ON.** The native manager is
 * process-wide, so destroying the TypeScript client left account A's manager and key installed into
 * account B's sign-in. Both exits end it: a retirement after the final write and the destroy (the write
 * needs the manager), a reset at once - and both inside {@link MlsHolder.whenRetired}, so the next login
 * opens its state only once the previous one's native session is gone. A reset scoped to a client that
 * is no longer current ends nothing: the native session is the next sign-in's by then.
 */
export function createMlsHolder(
  create: () => IMlsService,
  endNative: (reason: NativeMlsSessionEnd) => Promise<void>
): MlsHolder {
  let current: IMlsService | null = null;
  let retirement: Promise<void> = Promise.resolve();
  let pending = 0;

  /** Ends the native session for `reason`, never rejecting: a login awaits the chain it joins. */
  const endNativeLogged = (reason: NativeMlsSessionEnd) =>
    endNative(reason).catch((e) =>
      console.error(`[MLS] ending the native MLS session (${reason}) failed: ${e}`)
    );

  return {
    ensure() {
      if (!current) current = create();
      return current;
    },
    reset(only) {
      if (only && current !== only) return;
      current?.destroy?.();
      current = null;
      const ended = endNativeLogged(only ? 'stopped login' : 'client reset');
      retirement = Promise.all([retirement, ended]).then(() => undefined);
    },
    retire(finalWrite, why = 'sign-out') {
      const leaving = current;
      current = null;
      pending += 1;
      // NEVER REJECTS, WHATEVER THE CALLER HANDS IT: a login awaits this chain, so a rejection here
      // (a final write that broke its contract, a destroy that threw) would leave that login - and
      // `isLoginInProgress` - stuck, and `pending` counting a retirement that is over.
      const done = finalWrite
        .catch((e) => console.error(`[LOGOUT] retired MLS client's final write failed: ${e}`))
        .then(() => leaving?.destroy?.())
        .catch((e) => console.error(`[LOGOUT] destroying the retired MLS client failed: ${e}`))
        // AFTER the final write (it checkpoints through the manager this removes).
        .then(() => endNativeLogged(why))
        .finally(() => {
          pending -= 1;
        });
      // CHAINED, so a second sign-out before the first write lands is waited for too.
      retirement = Promise.all([retirement, done]).then(() => undefined);
      return done;
    },
    whenRetired: () => retirement,
    isRetiring: () => pending > 0,
  };
}
