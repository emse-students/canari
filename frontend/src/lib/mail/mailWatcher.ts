import { Log } from '$lib/utils/Log';
import type { MailApi } from './mailApi';
import { classifyMailFailure, type MailErrorKind } from './mailErrors';
import type { MailSession, MailSoap } from './mailSession';
import type { MessageSummary } from './mailTypes';
import {
  itemNumber,
  readMailWatchCursor,
  writeMailWatchCursor,
  type MailWatchCursor,
} from './mailWatchCursor';
import { parseCreatedWaitSet, parseWaitSetAnswer, type WaitSetHandle } from './zimbraParse';
import { createWaitSetRequest, destroyWaitSetRequest, waitSetRequest } from './zimbraRequests';

/**
 * THE NEW-MAIL WATCHER (docs/wiki/mail-client.md D11, docs/wiki/mail-client-transport.md#as-built---lot-4).
 *
 * TWO QUESTIONS, TWO ANSWERERS, AND NEITHER IS A CLOCK:
 *
 * - **"Has anything changed?"** is the SERVER's answer: a wait set (`CreateWaitSetRequest`) on the
 *   account's messages, and a `WaitSetRequest` that blocks on the server until they change. Measured
 *   on Partage 2026-11-27: `NoOpRequest wait=1` is refused there (no SOAP session is ever created),
 *   the wait set is accepted and blocks until its timeout (twenty empty 60 s waits in a row, each
 *   answered in 63 s). Its answer to a REAL change is Zimbra's documented one and is still owed a
 *   reading on Partage: no mail arrived during the probe, and the probe sends none.
 * - **"What is new to me?"** is the DEVICE's durable answer: the cursor (`mailWatchCursor.ts`), the
 *   highest inbox item id already considered. The inbox read by id, newest first, stops at the first
 *   id at or below it - the ids are handed out in increasing order, so that id is the PROOF that
 *   nothing older is new, whatever a page size says.
 *
 * The wait's `timeout` ({@link WAIT_TIMEOUT_SECONDS}) is not a decision: it keeps an idle connection
 * under the web relay's idle close. If it were wrong, a wait would end with nothing (one more empty
 * round trip) or the relay would cut it (a transport failure, retried) - never a mail missed, never one
 * notified twice, because neither question reads it.
 *
 * THE ORDER IS THE PROOF THAT NO CHANGE FALLS IN A GAP: the wait set is created FIRST, then the
 * inbox is read up to the cursor, then the wait starts from the wait set's first sequence - so a mail
 * arriving while the inbox is being read is still a change the wait set holds, and the wait answers
 * at once.
 *
 * "NEVER TWICE" IS THE CURSOR, WRITTEN BEFORE THE NOTIFICATION IS POSTED: a process killed between
 * the two loses that notification, never doubles it (and the notification's id is the message's, so
 * a repost would replace, not add). A mail read elsewhere before this device reads the inbox is past
 * the cursor too, and is not notified: a change that only reads, flags or moves a mail wakes the wait
 * and finds nothing above the cursor.
 *
 * It runs ONLY while its session is `ready`; a session that ends (signed out, password asked, account
 * closed) ends the run, and the controller (`mailWatch.svelte.ts`) starts a new one at the next
 * `ready`. A transport failure is retried - unbounded in count, bounded in rate, one rung at a time
 * ({@link retryDelayMs}); the pause also ends early on the controller's events (back online, back on
 * screen).
 */

/**
 * How long one `WaitSetRequest` may block on the server, in seconds. Measured on Partage 2026-11-27:
 * 60 answered after 63 s, 1 after 33 s (the server's floor is about 30 s), and with none given the
 * wait blocked past five minutes. It must stay under the web relay's idle close (100 s,
 * `IDLE_DEADLINE` in `mail_relay.rs`), with the measured overshoot: `mailWatcher.test.ts` asserts it.
 */
export const WAIT_TIMEOUT_SECONDS = 60;

/** How many inbox messages one read of the delta asks for (the next page only if the proof is not met). */
export const DELTA_PAGE_SIZE = 50;

/** Zimbra's fixed id of the inbox. */
export const INBOX_FOLDER_ID = '2';

/** A new unread inbox message: what a notification is made of. */
export type NewMail = Pick<MessageSummary, 'id' | 'conversationId' | 'from' | 'subject' | 'date'>;

/** What one read of the delta found. */
export interface DeltaRead {
  /** True when there was no cursor for this mailbox: one was taken, nothing is notified. */
  baseline: boolean;
  /** The new UNREAD inbox messages, newest first. */
  fresh: NewMail[];
  /** The cursor now written. */
  cursor: MailWatchCursor;
}

/**
 * Reads what is new in the inbox since the cursor, and WRITES THE NEW CURSOR before it returns. No
 * cursor for this mailbox takes a baseline - the newest inbox id - and notifies nothing: mail that
 * was there before the watcher is not news.
 */
export async function readNewInboxMail(
  api: Pick<MailApi, 'messages'>,
  userId: string,
  account: string,
  store: Storage = localStorage
): Promise<DeltaRead> {
  const cursor = readMailWatchCursor(userId, account, store);
  if (cursor === null) {
    const newest = await api.messages({
      folderId: INBOX_FOLDER_ID,
      query: '',
      offset: 0,
      limit: 1,
      sortBy: 'idDesc',
    });
    const top = newest.items.map((m) => itemNumber(m.id)).find((n) => n !== null) ?? 0;
    const taken = { account: account.toLowerCase(), highest: top };
    writeMailWatchCursor(userId, taken, store);
    Log.i('MAIL-WATCH', `baseline taken at item ${top} - nothing notified`);
    return { baseline: true, fresh: [], cursor: taken };
  }
  const above: MessageSummary[] = [];
  let offset = 0;
  let proven = false;
  for (;;) {
    const page = await api.messages({
      folderId: INBOX_FOLDER_ID,
      query: '',
      offset,
      limit: DELTA_PAGE_SIZE,
      sortBy: 'idDesc',
    });
    for (const item of page.items) {
      const n = itemNumber(item.id);
      if (n === null) continue;
      if (n <= cursor.highest) {
        proven = true;
        break;
      }
      above.push(item);
    }
    if (proven || !page.hasMore) break;
    if (page.items.length === 0) {
      // A page that says "more" and holds nothing cannot advance the offset: the read stops here
      // rather than ask the same page forever, and says so.
      Log.w('MAIL-WATCH', 'ERROR: an inbox page said more and held nothing - the read stops there');
      break;
    }
    offset += page.items.length;
  }
  const highest = above.reduce((top, m) => Math.max(top, itemNumber(m.id) ?? 0), cursor.highest);
  const next = { account: cursor.account, highest };
  if (highest !== cursor.highest) writeMailWatchCursor(userId, next, store);
  const fresh = above
    .filter((m) => m.flags.unread)
    .map(({ id, conversationId, from, subject, date }) => ({
      id,
      conversationId,
      from,
      subject,
      date,
    }));
  Log.d(
    'MAIL-WATCH',
    `delta: ${above.length} above the cursor, ${fresh.length} unread, cursor ${cursor.highest} -> ${highest}`
  );
  return { baseline: false, fresh, cursor: next };
}

/** The pause before the `failures`-th retry: 2 s, doubling, at most 5 min. A RATE bound only. */
export function retryDelayMs(failures: number): number {
  return Math.min(300_000, 2_000 * 2 ** Math.max(0, failures - 1));
}

/**
 * The failures after which the run ENDS rather than retries: the session itself is gone or refused
 * (its state machine owns what happens next, and the controller starts a new run at `ready`), or the
 * mailbox is not one this account may watch.
 */
const ENDS_THE_RUN: ReadonlySet<MailErrorKind> = new Set<MailErrorKind>([
  'session_expired',
  'not_signed_in',
  'bad_credentials',
  'password_change_required',
  'account_closed',
  'account_unavailable',
  'address_unknown',
  'not_eligible',
  'incompatible',
]);

/** What the watcher needs, injected so a test drives it with `FakeZimbra`. */
export interface MailWatcherDeps {
  userId: string;
  session: Pick<MailSession, 'callOver' | 'state'>;
  api: Pick<MailApi, 'messages'>;
  /** A NEW connection for the blocking wait (see `MailSession.callOver`). */
  openWaitChannel(): Pick<MailSoap, 'call' | 'close'>;
  /** Posts one notification per new unread message. Never throws (it logs its own failures). */
  notify(fresh: NewMail[]): Promise<void>;
  /** Resolves after `ms`, or earlier when `signal` aborts or the controller's events say "retry now". */
  pause(ms: number, signal: AbortSignal): Promise<void>;
  store?: Storage;
}

/** How one {@link MailWatcher.checkOnce} ended (the iOS background refresh reports it to the system). */
export type CheckOutcome = 'done' | 'not_ready' | 'failed';

/** The account a `ready` session is signed in to, or `null`. */
function readyAccount(session: Pick<MailSession, 'state'>): string | null {
  const state = session.state;
  return state.kind === 'ready' ? state.account.address : null;
}

export class MailWatcher {
  private run: AbortController | null = null;
  /** The run's own connection, closed by {@link stop} to end a wait in flight. */
  private channel: Pick<MailSoap, 'call' | 'close'> | null = null;
  private running: Promise<void> | null = null;
  /** The delta in flight: the loop and a background check never read and write the cursor at once. */
  private delta: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: MailWatcherDeps) {}

  /** Whether a run is going on. */
  get active(): boolean {
    return this.run !== null;
  }

  /** Starts a run if none is going on. Idempotent. */
  start(): void {
    if (this.run) return;
    const run = new AbortController();
    const channel = this.deps.openWaitChannel();
    this.run = run;
    this.channel = channel;
    Log.i('MAIL-WATCH', 'watching for new mail');
    this.running = this.loop(run.signal, channel).finally(() => {
      if (this.run === run) {
        this.run = null;
        this.channel = null;
      }
    });
  }

  /** Ends the run (closing its connection ends a wait in flight) and waits until it has. */
  async stop(reason: string): Promise<void> {
    const run = this.run;
    if (!run) return;
    Log.i('MAIL-WATCH', `stop: ${reason}`);
    const channel = this.channel;
    this.run = null;
    this.channel = null;
    run.abort();
    // A wait blocks on the server for up to a minute: closing its connection ends it now.
    channel?.close();
    await this.running;
  }

  /**
   * ONE read of the delta and its notifications, no wait - the iOS background refresh. `not_ready`
   * when the session is not signed in (nothing was asked of the server).
   */
  async checkOnce(): Promise<CheckOutcome> {
    const account = readyAccount(this.deps.session);
    if (!account) {
      Log.i('MAIL-WATCH', 'check: the mailbox is not open - nothing read');
      return 'not_ready';
    }
    try {
      await this.readAndNotify(account);
      return 'done';
    } catch (err) {
      const failure = classifyMailFailure(err);
      Log.w('MAIL-WATCH', `check failed (${failure.kind}, ${failure.code})`);
      return 'failed';
    }
  }

  /** The delta, then its notifications - one at a time (see {@link delta}). */
  private readAndNotify(account: string): Promise<void> {
    const next = this.delta.then(async () => {
      const read = await readNewInboxMail(
        this.deps.api,
        this.deps.userId,
        account,
        this.deps.store
      );
      if (read.fresh.length > 0) await this.deps.notify(read.fresh);
    });
    this.delta = next.catch(() => undefined);
    return next;
  }

  private async loop(
    signal: AbortSignal,
    channel: Pick<MailSoap, 'call' | 'close'>
  ): Promise<void> {
    const { session } = this.deps;
    let handle: WaitSetHandle | null = null;
    let readDelta = true;
    let failures = 0;
    try {
      while (!signal.aborted) {
        const account = readyAccount(session);
        if (!account) {
          Log.i('MAIL-WATCH', `the mailbox is ${session.state.kind} - the run ends`);
          return;
        }
        try {
          if (!handle) {
            handle = parseCreatedWaitSet(
              await session.callOver(channel, createWaitSetRequest(account))
            );
            Log.d('MAIL-WATCH', 'wait set created');
            readDelta = true;
          }
          if (readDelta) {
            await this.readAndNotify(account);
            readDelta = false;
          }
          if (signal.aborted) return;
          const answer = parseWaitSetAnswer(
            await session.callOver(
              channel,
              waitSetRequest(handle.waitSet, handle.seq, WAIT_TIMEOUT_SECONDS)
            )
          );
          if (signal.aborted) return;
          failures = 0;
          if (answer.canceled) {
            Log.i('MAIL-WATCH', 'the server cancelled the wait set - another is created');
            handle = null;
            continue;
          }
          handle = { waitSet: handle.waitSet, seq: answer.seq };
          if (answer.changed) {
            Log.d('MAIL-WATCH', 'the mailbox changed - reading the delta');
            readDelta = true;
          }
        } catch (err) {
          if (signal.aborted) return;
          const failure = classifyMailFailure(err);
          if (failure.kind === 'wait_lost') {
            // The server's own answer that the wait set is gone: another, at once - a proof, not a guess.
            Log.i('MAIL-WATCH', 'the wait set lapsed on the server - another is created');
            handle = null;
            continue;
          }
          if (ENDS_THE_RUN.has(failure.kind)) {
            Log.i('MAIL-WATCH', `the run ends: ${failure.kind} (${failure.code})`);
            return;
          }
          failures++;
          // The delta is read again after any failure: the wait set may have lapsed meanwhile.
          readDelta = true;
          const delay = retryDelayMs(failures);
          Log.w(
            'MAIL-WATCH',
            `${failure.kind} (${failure.code}) - retry ${failures} in at most ${delay} ms`
          );
          await this.deps.pause(delay, signal);
        }
      }
    } finally {
      await this.release(channel, handle);
    }
  }

  /** Releases the wait set on the server while the session still can, then closes the connection. */
  private async release(
    channel: Pick<MailSoap, 'call' | 'close'>,
    handle: WaitSetHandle | null
  ): Promise<void> {
    if (!handle || !readyAccount(this.deps.session)) {
      channel.close();
      return;
    }
    try {
      await this.deps.session.callOver(channel, destroyWaitSetRequest(handle.waitSet));
    } catch (err) {
      // It lapses on the server by itself; the line says it was not released.
      Log.d('MAIL-WATCH', `the wait set was not released (${classifyMailFailure(err).kind})`);
    } finally {
      channel.close();
    }
  }
}
