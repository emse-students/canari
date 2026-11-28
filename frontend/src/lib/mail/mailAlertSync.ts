import { Log } from '$lib/utils/Log';
import { MailAlertServerError, type MailAlertOutcome } from './mailAlert';

/**
 * WHEN THE ACCOUNT'S ALERT IS BROUGHT TO WHAT THIS DEVICE WANTS (mail lot 5,
 * docs/wiki/mail-client-transport.md#as-built---lot-5) - the scheduling half of `mailAlert.ts`.
 *
 * The controller (`mailWatch.svelte.ts`) hands every change of the facts to {@link MailAlertSync.update};
 * a sync runs only while the mailbox is OPEN (`ready`: the rules are the mailbox's) and the server's
 * `mail_push` is READ (a default is never a reason to change anything). A mailbox that LEFT `ready`
 * for good - its password refused, the account closed (D8), the mail tab off - is a LEAVE instead:
 * this device's subscription is taken back server-side (no mailbox needed), so no push reaches it
 * (`leaveMailAlert`). ONE task runs at a time; facts that change meanwhile are kept and acted on once
 * it settles. A task that failed is tried again at the next change of a fact - never on a timer - and
 * a subscription the server refused for want of a push registration is tried ONCE more when the
 * registration completes ({@link MailAlertSync.retryAfterPushRegistration}).
 */

/** Why a mailbox that is not open leaves the alert (none: it may open again by itself). */
export type AlertLeaveCause = 'password_refused' | 'account_closed' | 'mail_off';

/** The facts one sync depends on. */
export interface AlertSyncInput {
  userId: string;
  /** The mailbox is open, so its rules can be read and written. */
  ready: boolean;
  /** The server's `mail_push` is a READ answer, not its default. */
  pushKnown: boolean;
  /** This device wants the empty mail push (see `mailWatch.svelte.ts` for the facts). */
  want: boolean;
  /** Set while the mailbox is not open for one of the causes that take this device out. */
  leave?: AlertLeaveCause | null;
}

/** What a sync does: `mailAlert.syncMailAlert` with this device's dependencies, plus the iOS secret. */
export type AlertSyncRun = (userId: string, want: boolean) => Promise<MailAlertOutcome>;

/** What a leave does: `mailAlert.leaveMailAlert` with this device's dependencies. */
export type AlertLeaveRun = (userId: string, cause: AlertLeaveCause) => Promise<MailAlertOutcome>;

/** The single-flight scheduler of one document. */
export interface MailAlertSync {
  update(input: AlertSyncInput): void;
  /**
   * A Canari sign-out is starting: nothing new starts until the mailbox is reported closed (the
   * sign-out's own release runs then, alone); settles once the task in flight has.
   */
  quiesce(): Promise<void>;
  /** The push registration completed: a sync the server refused for want of one is tried again. */
  retryAfterPushRegistration(): void;
  /** Settles once no task is running or owed (for the tests). */
  idle(): Promise<void>;
}

type Task =
  | { kind: 'sync'; input: AlertSyncInput }
  | { kind: 'leave'; userId: string; cause: AlertLeaveCause };

/** Builds the scheduler around `run` (and `leave`, for a mailbox that left `ready`). */
export function createMailAlertSync(run: AlertSyncRun, leave?: AlertLeaveRun): MailAlertSync {
  let running: Promise<void> | null = null;
  let owed: Task | null = null;
  /** The last task COMPLETED: the same task again is nothing to do. */
  let done: string | null = null;
  /** A sign-out is under way: nothing starts until the mailbox closes. */
  let quiet = false;
  /** The sync the server refused for want of a push registration, kept for one retry. */
  let awaitingRegistration: AlertSyncInput | null = null;

  const keyOf = (task: Task) =>
    task.kind === 'sync'
      ? `${task.input.userId}|${task.input.want}`
      : `${task.userId}|leave|${task.cause}`;

  const perform = async (task: Task): Promise<void> => {
    const key = keyOf(task);
    if (key === done) return;
    try {
      if (task.kind === 'sync') {
        const outcome = await run(task.input.userId, task.input.want);
        Log.i('MAIL-ALERT', `sync (want=${task.input.want}): ${outcome}`);
      } else if (leave) {
        const outcome = await leave(task.userId, task.cause);
        Log.i('MAIL-ALERT', `leave (${task.cause}): ${outcome}`);
      }
      done = key;
    } catch (err) {
      done = null;
      if (
        task.kind === 'sync' &&
        err instanceof MailAlertServerError &&
        err.kind === 'not_registered'
      ) {
        awaitingRegistration = task.input;
        Log.i('MAIL-ALERT', 'no push registration yet - the sync runs again when it completes');
        return;
      }
      Log.w('MAIL-ALERT', `ERROR: the alert ${task.kind} failed - retried at the next fact`, err);
    }
  };

  const drain = async (): Promise<void> => {
    while (owed && !quiet) {
      const task = owed;
      owed = null;
      await perform(task);
    }
  };

  const schedule = (task: Task) => {
    owed = task;
    if (running || quiet) return;
    running = drain().finally(() => {
      running = null;
    });
  };

  return {
    update(input) {
      if (!input.ready) {
        // A mailbox that closes forgets what was done, so its next opening checks the alert again
        // (another device may have changed it meanwhile). A closed mailbox ends a sign-out's quiet.
        if (done !== null && !done.includes('|leave|')) done = null;
        quiet = false;
        if (input.leave) schedule({ kind: 'leave', userId: input.userId, cause: input.leave });
        return;
      }
      if (!input.pushKnown || quiet) return;
      schedule({ kind: 'sync', input });
    },
    async quiesce() {
      quiet = true;
      owed = null;
      while (running) await running;
    },
    retryAfterPushRegistration() {
      const input = awaitingRegistration;
      awaitingRegistration = null;
      if (!input || quiet) return;
      Log.i('MAIL-ALERT', 'the push registration completed - the refused sync runs once more');
      done = null;
      schedule({ kind: 'sync', input });
    },
    async idle() {
      while (running) await running;
    },
  };
}

/** The alert scheduler of this document, once the controller runs (a sign-out chains behind it). */
let documentAlertSync: MailAlertSync | null = null;

/** The controller (`mailWatch.svelte.ts`) registers its scheduler. */
export function setDocumentAlertSync(sync: MailAlertSync): void {
  documentAlertSync = sync;
}

/**
 * A Canari sign-out is starting: the alert task in flight settles, and none starts until the mailbox
 * closes - so an `ensure` running when the sign-out began never writes the rule after its release.
 */
export function quiesceMailAlertSync(): Promise<void> {
  return documentAlertSync?.quiesce() ?? Promise.resolve();
}
