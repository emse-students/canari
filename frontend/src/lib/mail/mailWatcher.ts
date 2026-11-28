import { Log } from '$lib/utils/Log';
import { classifyMailFailure, MailError, type MailErrorKind } from './mailErrors';
import type { MailSession, MailSoap } from './mailSession';
import type { MessageSummary } from './mailTypes';
import {
  itemNumber,
  platformCursorStore,
  readMailWatchCursor,
  writeMailWatchCursor,
  type MailCursorStore,
  type MailWatchCursor,
} from './mailWatchCursor';
import {
  parseCreatedWaitSet,
  parseMessagePage,
  parseWaitSetAnswer,
  type WaitSetHandle,
} from './zimbraParse';
import {
  createWaitSetRequest,
  destroyWaitSetRequest,
  searchRequest,
  waitSetRequest,
} from './zimbraRequests';

/**
 * THE NEW-MAIL WATCHER (docs/wiki/mail-client.md D11, docs/wiki/mail-client-transport.md#as-built---lot-4).
 *
 * TWO QUESTIONS, TWO ANSWERERS, AND NEITHER IS A CLOCK:
 *
 * - **"Has anything changed?"** is the SERVER's answer: a wait set (`CreateWaitSetRequest`) on the
 *   account's messages, and a `WaitSetRequest` that blocks on the server until they change. Measured
 *   on Partage 2026-11-27: `NoOpRequest wait=1` is refused there (no SOAP session is ever created),
 *   the wait set is accepted, blocks until its timeout (twenty empty 60 s waits in a row, each
 *   answered in 63 s), and wakes on ANY change of the mailbox (measured 2026-11-28: a mail sent to
 *   oneself woke it twice, ~0.1 s for the Sent copy - an empty inbox delta - and ~0.4 s for the
 *   delivery, whose delta held exactly that mail).
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

/** One Zimbra SOAP call with the session's token, over whichever connection the reader holds. */
export type MailCall = (body: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** The search of one page of the inbox, newest id first, after `after` when given. */
function inboxPage(limit: number, after?: string): Record<string, unknown> {
  return searchRequest('message', {
    folderId: INBOX_FOLDER_ID,
    query: '',
    offset: 0,
    limit,
    sortBy: 'idDesc',
    ...(after !== undefined ? { after } : {}),
  });
}

/** Thrown when the session moved (signed out, closed, signed in again) while a delta was read. */
function superseded(): MailError {
  return new MailError('not_signed_in', 'session-moved-during-delta');
}

/**
 * Reads what is new in the inbox since the cursor, and WRITES THE NEW CURSOR before it returns. No
 * cursor for this mailbox takes a baseline - the newest numeric inbox id - and notifies nothing: mail
 * that was there before the watcher is not news.
 *
 * Pages follow the ids (`after`, Zimbra's cursor), never an offset: a mail arriving or deleted
 * mid-read cannot shift a page. `current` is checked before the cursor is written: a session that
 * moved meanwhile (another sign-in, a sign-out) writes nothing and throws `not_signed_in`.
 *
 * @returns `fresh` empty and nothing written when the cursor could not be written (logged): the
 * mail is then announced by the next read rather than twice.
 */
export async function readNewInboxMail(
  call: MailCall,
  userId: string,
  account: string,
  store: MailCursorStore,
  current: () => boolean = () => true
): Promise<DeltaRead> {
  const cursor = await readMailWatchCursor(userId, account, store);
  if (cursor === null) {
    const newest = parseMessagePage(await call(inboxPage(DELTA_PAGE_SIZE)), 0);
    const top = newest.items.map((m) => itemNumber(m.id)).find((n) => n !== null) ?? 0;
    const taken = { account: account.toLowerCase(), highest: top };
    if (!current()) throw superseded();
    const written = await writeMailWatchCursor(userId, taken, null, store);
    Log.i('MAIL-WATCH', `baseline taken at item ${top} (written: ${written}) - nothing notified`);
    return { baseline: true, fresh: [], cursor: taken };
  }
  const above: MessageSummary[] = [];
  let after: string | undefined;
  let proven = false;
  for (;;) {
    const page = parseMessagePage(await call(inboxPage(DELTA_PAGE_SIZE, after)), 0);
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
    const last = page.items[page.items.length - 1];
    if (!last) {
      // A page that says "more" and holds nothing gives no id to read after: the read stops here
      // rather than ask the same page forever, and says so.
      Log.w('MAIL-WATCH', 'ERROR: an inbox page said more and held nothing - the read stops there');
      break;
    }
    after = last.id;
  }
  const highest = above.reduce((top, m) => Math.max(top, itemNumber(m.id) ?? 0), cursor.highest);
  const next = { account: cursor.account, highest };
  if (!current()) throw superseded();
  if (highest !== cursor.highest && !(await writeMailWatchCursor(userId, next, cursor, store))) {
    Log.w(
      'MAIL-WATCH',
      'the cursor was not written (or moved meanwhile) - nothing notified, the next read retries'
    );
    return { baseline: false, fresh: [], cursor };
  }
  const fresh = above
    .filter((m) => m.flags.unread)
    .map(({ id, conversationId, from, subject, date }) => ({
      id,
      conversationId,
      from,
      subject,
      date,
    }));
  // An empty delta is ORDINARY: every change of the mailbox wakes the wait (a mail sent lands in
  // Sent and wakes it first, measured 2026-11-28), so this line stays at debug.
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
  session: Pick<MailSession, 'call' | 'callOver' | 'state' | 'generation'>;
  /** A NEW connection for the run: its wait AND its delta reads (see `MailSession.callOver`). */
  openWaitChannel(): Pick<MailSoap, 'call' | 'close'>;
  /** Posts the notifications of new unread messages. Never throws (it logs its own failures). */
  notify(fresh: NewMail[]): Promise<void>;
  /** Resolves after `ms`, or earlier when `signal` aborts or the controller's events say "retry now". */
  pause(ms: number, signal: AbortSignal): Promise<void>;
  /**
   * Told when a run ends BY ITSELF - its session ended, the mailbox refused - never after
   * {@link MailWatcher.stop}: the controller releases what it held for the run (the Web Lock, the
   * Android service) and starts a new one only when its facts say so.
   */
  onRunEnded?(reason: string): void;
  /** Where the cursor is kept (the platform's by default). */
  store?: MailCursorStore;
}

/** How one {@link MailWatcher.checkOnce} ended (the iOS background refresh reports it to the system). */
export type CheckOutcome = 'done' | 'not_ready' | 'failed';

/** The account a `ready` session is signed in to, or `null`. */
function readyAccount(session: Pick<MailSession, 'state'>): string | null {
  const state = session.state;
  return state.kind === 'ready' ? state.account.address : null;
}

/** One run's connection, and whether {@link MailWatcher.stop} closed it. */
interface RunChannel {
  soap: Pick<MailSoap, 'call' | 'close'>;
  closed: boolean;
}

export class MailWatcher {
  private run: AbortController | null = null;
  /** The run's own connection, closed by {@link stop} to end a wait or a read in flight. */
  private channel: RunChannel | null = null;
  private running: Promise<void> | null = null;
  /** The delta in flight: the loop and a background check never read and write the cursor at once. */
  private delta: Promise<unknown> = Promise.resolve();
  private readonly store: MailCursorStore;

  constructor(private readonly deps: MailWatcherDeps) {
    this.store = deps.store ?? platformCursorStore();
  }

  /** Whether a run is going on. */
  get active(): boolean {
    return this.run !== null;
  }

  /** Starts a run if none is going on. Idempotent. */
  start(): void {
    if (this.run) return;
    const run = new AbortController();
    const channel: RunChannel = { soap: this.deps.openWaitChannel(), closed: false };
    this.run = run;
    this.channel = channel;
    Log.i('MAIL-WATCH', 'watching for new mail');
    const settle = (ended: string) => {
      if (this.run === run) {
        this.run = null;
        this.channel = null;
      }
      if (!run.signal.aborted) this.deps.onRunEnded?.(ended);
    };
    this.running = this.loop(run.signal, channel).then(settle, (err: unknown) => {
      // The loop catches every failure it can classify; reaching here is a defect, said as one.
      Log.w('MAIL-WATCH', `ERROR: the run ended on an unexpected throw (${String(err)})`);
      settle('an unexpected throw');
    });
  }

  /** Ends the run (closing its connection ends a wait or a read in flight) and waits until it has. */
  async stop(reason: string): Promise<void> {
    const run = this.run;
    if (!run) return;
    Log.i('MAIL-WATCH', `stop: ${reason}`);
    const channel = this.channel;
    this.run = null;
    this.channel = null;
    run.abort();
    if (channel) {
      channel.closed = true;
      channel.soap.close();
    }
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
      await this.readAndNotify((body) => this.deps.session.call(body), account);
      return 'done';
    } catch (err) {
      const failure = classifyMailFailure(err);
      Log.w('MAIL-WATCH', `check failed (${failure.kind}, ${failure.code})`);
      return 'failed';
    }
  }

  /**
   * The delta, then its notifications - one at a time (see {@link delta}). Nothing is written or
   * notified once the session's generation moved, or its mailbox changed, since the read began.
   */
  private readAndNotify(call: MailCall, account: string): Promise<void> {
    const { session } = this.deps;
    const generation = session.generation;
    const current = () => session.generation === generation && readyAccount(session) === account;
    const next = this.delta.then(async () => {
      const read = await readNewInboxMail(call, this.deps.userId, account, this.store, current);
      if (read.fresh.length === 0) return;
      if (!current()) {
        Log.i('MAIL-WATCH', 'the session moved after the read - nothing notified');
        return;
      }
      await this.deps.notify(read.fresh);
    });
    this.delta = next.catch(() => undefined);
    return next;
  }

  /** One run; resolves with why it ended. */
  private async loop(signal: AbortSignal, channel: RunChannel): Promise<string> {
    const { session } = this.deps;
    const call: MailCall = (body) => session.callOver(channel.soap, body);
    let handle: WaitSetHandle | null = null;
    let readDelta = true;
    let failures = 0;
    // Whether a wait on the CURRENT wait set has blocked and answered normally: a wait set lost or
    // cancelled before that is a failure of the ladder, never a free re-creation (a server that
    // cancels every new wait set would otherwise be asked again with no bound on the rate).
    let healthy = false;
    try {
      while (!signal.aborted) {
        const account = readyAccount(session);
        if (!account) {
          Log.i('MAIL-WATCH', `the mailbox is ${session.state.kind} - the run ends`);
          return `the mailbox is ${session.state.kind}`;
        }
        try {
          if (!handle) {
            handle = parseCreatedWaitSet(await call(createWaitSetRequest(account)));
            healthy = false;
            Log.d('MAIL-WATCH', 'wait set created');
            readDelta = true;
          }
          if (readDelta) {
            await this.readAndNotify(call, account);
            readDelta = false;
          }
          if (signal.aborted) break;
          const answer = parseWaitSetAnswer(
            await call(waitSetRequest(handle.waitSet, handle.seq, WAIT_TIMEOUT_SECONDS))
          );
          if (signal.aborted) break;
          if (answer.canceled) {
            handle = null;
            failures = await this.lostWaitSet('cancelled by the server', healthy, failures, signal);
            readDelta = true;
            continue;
          }
          failures = 0;
          healthy = true;
          handle = { waitSet: handle.waitSet, seq: answer.seq };
          if (answer.changed) {
            Log.d('MAIL-WATCH', 'the mailbox changed - reading the delta');
            readDelta = true;
          }
        } catch (err) {
          if (signal.aborted) break;
          const failure = classifyMailFailure(err);
          if (failure.kind === 'wait_lost') {
            handle = null;
            failures = await this.lostWaitSet('lapsed on the server', healthy, failures, signal);
            readDelta = true;
            continue;
          }
          if (ENDS_THE_RUN.has(failure.kind)) {
            Log.i('MAIL-WATCH', `the run ends: ${failure.kind} (${failure.code})`);
            return `${failure.kind} (${failure.code})`;
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
      return 'stopped';
    } finally {
      await this.release(channel, handle);
    }
  }

  /**
   * A wait set the server dropped (`wait_lost`, or `canceled`): another at once when the last one
   * had blocked normally - the server's own answer, a proof - or after the ladder's next rung when it
   * had not. Returns the failure count to carry on with.
   */
  private async lostWaitSet(
    why: string,
    healthy: boolean,
    failures: number,
    signal: AbortSignal
  ): Promise<number> {
    if (healthy) {
      Log.i('MAIL-WATCH', `the wait set was ${why} - another is created`);
      return failures;
    }
    const count = failures + 1;
    const delay = retryDelayMs(count);
    Log.w(
      'MAIL-WATCH',
      `the wait set was ${why} before any wait blocked - retry ${count} in at most ${delay} ms`
    );
    await this.deps.pause(delay, signal);
    return count;
  }

  /**
   * Releases the wait set on the server while the session still can, then closes the connection. A
   * connection {@link stop} closed cannot carry it: a spare one does, closed after.
   */
  private async release(channel: RunChannel, handle: WaitSetHandle | null): Promise<void> {
    if (!handle || !readyAccount(this.deps.session)) {
      channel.soap.close();
      return;
    }
    const via = channel.closed ? this.deps.openWaitChannel() : channel.soap;
    try {
      await this.deps.session.callOver(via, destroyWaitSetRequest(handle.waitSet));
      Log.d('MAIL-WATCH', 'wait set released');
    } catch (err) {
      // It lapses on the server by itself; the line says it was not released.
      Log.d('MAIL-WATCH', `the wait set was not released (${classifyMailFailure(err).kind})`);
    } finally {
      via.close();
      channel.soap.close();
    }
  }
}
