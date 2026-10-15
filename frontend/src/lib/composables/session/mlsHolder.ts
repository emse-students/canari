import type { IMlsService } from '$lib/mls-client';

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
  /** Destroys the current client now (a failed login, a revoked device). */
  reset(): void;
  /**
   * Lets go of the current client now and destroys it once `finalWrite` settles. `finalWrite` must
   * never reject: it is the teardown's flush, which reports its own failure.
   */
  retire(finalWrite: Promise<void>): Promise<void>;
  /** Settles once every retired client's final write has landed and the client is destroyed. */
  whenRetired(): Promise<void>;
  /** True while a retired client's final write is still in flight. */
  isRetiring(): boolean;
}

/** Builds the holder over `create`, the platform's client factory. */
export function createMlsHolder(create: () => IMlsService): MlsHolder {
  let current: IMlsService | null = null;
  let retirement: Promise<void> = Promise.resolve();
  let pending = 0;

  return {
    ensure() {
      if (!current) current = create();
      return current;
    },
    reset() {
      current?.destroy?.();
      current = null;
    },
    retire(finalWrite) {
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
