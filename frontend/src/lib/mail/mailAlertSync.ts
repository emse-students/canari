import { Log } from '$lib/utils/Log';
import type { MailAlertOutcome } from './mailAlert';

/**
 * WHEN THE ACCOUNT'S ALERT IS BROUGHT TO WHAT THIS DEVICE WANTS (mail lot 5,
 * docs/wiki/mail-client-transport.md#as-built---lot-5) - the scheduling half of `mailAlert.ts`.
 *
 * The controller (`mailWatch.svelte.ts`) hands every change of the facts to {@link MailAlertSync.update};
 * a sync runs only while the mailbox is OPEN (`ready`: the preferences are the mailbox's) and the
 * server's `mail_push` is READ (a default is never a reason to restore anything). ONE sync runs at a
 * time; facts that change meanwhile are kept and synced once it settles. A sync that failed is tried
 * again at the next change of a fact - never on a timer.
 */

/** The facts one sync depends on. */
export interface AlertSyncInput {
  userId: string;
  /** The mailbox is open, so its preferences can be read and written. */
  ready: boolean;
  /** The server's `mail_push` is a READ answer, not its default. */
  pushKnown: boolean;
  /** This device wants the empty mail push (see `mailWatch.svelte.ts` for the facts). */
  want: boolean;
}

/** What a sync does: `mailAlert.syncMailAlert` with this device's dependencies, plus the iOS secret. */
export type AlertSyncRun = (userId: string, want: boolean) => Promise<MailAlertOutcome>;

/** The single-flight scheduler of one document. */
export interface MailAlertSync {
  update(input: AlertSyncInput): void;
  /** Settles once no sync is running or owed (for the tests). */
  idle(): Promise<void>;
}

/** Builds the scheduler around `run`. */
export function createMailAlertSync(run: AlertSyncRun): MailAlertSync {
  let running: Promise<void> | null = null;
  let owed: AlertSyncInput | null = null;
  /** The last input a sync COMPLETED for: the same input again is nothing to do. */
  let done: string | null = null;

  const keyOf = (input: AlertSyncInput) => `${input.userId}|${input.want}`;

  const drain = async (): Promise<void> => {
    while (owed) {
      const input = owed;
      owed = null;
      const key = keyOf(input);
      if (key === done) continue;
      try {
        const outcome = await run(input.userId, input.want);
        done = key;
        Log.i('MAIL-ALERT', `sync (want=${input.want}): ${outcome}`);
      } catch (err) {
        done = null;
        Log.w(
          'MAIL-ALERT',
          `ERROR: the alert sync failed (want=${input.want}) - retried at the next fact`,
          err
        );
      }
    }
  };

  return {
    update(input) {
      if (!input.ready || !input.pushKnown) {
        // Nothing can be read or decided now. A mailbox that closes forgets what was done, so its
        // next opening checks the alert again (another device may have changed it meanwhile).
        if (!input.ready) done = null;
        return;
      }
      owed = input;
      if (running) return;
      running = drain().finally(() => {
        running = null;
      });
    },
    async idle() {
      while (running) await running;
    },
  };
}
