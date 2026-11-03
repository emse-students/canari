import { isIosTauriRuntime } from '$lib/utils/appVersion';

/**
 * RUNS THE PAGE'S LAST WORK BEFORE iOS SUSPENDS IT UNDER A BACKGROUND TASK (2026-11-02).
 *
 * A read made inside the 2 s window before leaving the app is delivered when the app leaves the
 * screen - handed to the outbox, whose send is an encrypt and a POST - and nothing held the process
 * for it: iOS suspended the app seconds later and the read reached the account's other devices at
 * the next open. The native shell begins a `canari-leave-flush` background task on
 * `begin_background_flush` and ends it on `end_background_flush` (`canari_push.mm`,
 * `commands::background_flush`).
 *
 * NO TIMER. The hold is asked for BEFORE the work and ended when the work settles, whichever way;
 * the only other end is iOS's own expiration, which the shell logs as an ERROR - the read is then
 * still owed (durable, and mirrored for the native drain) and leaves with the next one.
 *
 * Every other runtime runs `work` as it is: a web tab, a desktop window and an Android app are not
 * suspended seconds after leaving the screen.
 *
 * @param reason what the hold is for, in the native log.
 * @param work the delivery; its rejection is reported here and ends the hold as `failed`.
 */
export async function holdWhileLeaving(
  reason: string,
  work: () => Promise<unknown>
): Promise<void> {
  if (!isIosTauriRuntime()) {
    await work();
    return;
  }
  const { invoke } = await import('@tauri-apps/api/core');
  let hold: number | null = null;
  try {
    hold = await invoke<number | null>('begin_background_flush', { reason });
  } catch (e) {
    // The work still runs, unheld - exactly as it did before the hold existed - and this accuses.
    console.error(`[LEAVE_FLUSH] no hold for ${reason}: ${String(e)}`);
  }
  let outcome = 'done';
  try {
    await work();
  } catch (e) {
    outcome = 'failed';
    console.error(`[LEAVE_FLUSH] ${reason}: the delivery threw: ${String(e)}`);
  } finally {
    if (hold !== null) {
      try {
        await invoke('end_background_flush', { hold, outcome });
      } catch (e) {
        console.error(
          `[LEAVE_FLUSH] hold ${hold} not ended (${outcome}): ${String(e)} - iOS ends it at its deadline`
        );
      }
    }
  }
}
