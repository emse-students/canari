import { isTauriRuntime } from '$lib/utils/tauriRuntime';

/** Why the native MLS session ends - carried to the native log line, never branched on. */
export type NativeMlsSessionEnd =
  | 'sign-out'
  | 'lost session'
  | 'stopped login'
  | 'client reset'
  | 'failed initialiser_mls'
  | 'state reset'
  | 'factory wipe';

/**
 * Ends this process's native MLS session: the manager, its cached at-rest key and the warm-process
 * mark (`terminer_session_mls`, `end_native_session` in `concurrency.rs`), and with `sweepState` the
 * state files in the SAME native hold.
 *
 * **THE ONE CALL EVERY PATH THAT ENDS AN ACCOUNT'S MLS SESSION GOES THROUGH.** On a phone a sign-out
 * is an in-app navigation, not a restart, so the process-wide manager of account A was still installed
 * when account B signed in - and a failed sign-in of B left it there, because the native side only ever
 * wrote `Some`. The callers: the MLS holder's retirement and reset (sign-out, account switch, a stopped
 * or failed login), a failed `initialiser_mls`, `removeMlsState` and the factory wipe.
 *
 * Web has no native session: its manager is the WASM client the holder destroys, so this resolves at
 * once there. A rejection propagates - the caller decides what a teardown it could not run means.
 */
export async function endNativeMlsSession(
  reason: NativeMlsSessionEnd,
  opts: { sweepState: boolean }
): Promise<void> {
  if (!isTauriRuntime()) return;
  // DEBUG: the native closing line says what was ended, at INFO only when something was.
  console.debug(
    `[MLS] ending the native MLS session (${reason}, state files ${opts.sweepState ? 'swept' : 'kept'})`
  );
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('terminer_session_mls', { reason, sweepState: opts.sweepState });
}
