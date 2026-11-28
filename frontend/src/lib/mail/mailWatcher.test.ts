// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FakeStream,
  FakeZimbra,
  zimbraBody,
  zimbraFault,
  type FakeZimbraAnswer,
} from '../../test/mailFakes';
import { ACCOUNT_KEY } from '$lib/utils/accountLocalKeys';
import { Log } from '$lib/utils/Log';
import { classifyMailFailure } from './mailErrors';
import { eraseMailLocalData } from './mailLocalData';
import { MailSession } from './mailSession';
import { readMailWatchCursor, webCursorStore, type MailCursorStore } from './mailWatchCursor';
import {
  DELTA_PAGE_SIZE,
  MailWatcher,
  WAIT_TIMEOUT_SECONDS,
  readNewInboxMail,
  retryDelayMs,
  type MailCall,
  type NewMail,
} from './mailWatcher';
import { ZimbraSoapClient } from './soapClient';

/**
 * The new-mail watcher over a fake Partage (lot 4), in the shapes MEASURED on Partage 2026-11-28:
 * `CreateWaitSetResponse {waitSet, defTypes, seq: "0"}`, a change answered `{a: [{id, changeid}],
 * waitSet, seq}` with a string `seq` that moves at every wake, and a mail sent waking the wait TWICE
 * (its Sent copy first: an empty inbox delta). A change is one notification per new unread message,
 * never twice - not across a wake, not across a restart (the cursor) - nothing for a change that only
 * reads, flags, moves or sends, the wait set created before the inbox is read, and the D8 erasure
 * takes the cursor.
 */

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(5)));
const ADDRESS = 'ada@etu.emse.fr';
const USER = 'u1';

interface Item {
  id: number | string;
  unread: boolean;
  /** A folder other than the inbox (2) is not listed by the inbox search. */
  folder?: string;
}

const num = (i: Item) => Number(String(i.id).split(':').pop());

/** A fake mailbox: the inbox, the wait sets, and a wait the test releases. */
class Box {
  items: Item[] = [];
  waitSets = new Set<string>();
  created = 0;
  seq = 0;
  /** When set, a new wait set's FIRST wait is answered `canceled`. */
  cancelFirstWait = false;
  private firstWaitOf = new Set<string>();
  private held: ((answer: FakeZimbraAnswer) => void) | null = null;

  get waiting(): boolean {
    return this.held !== null;
  }

  /** The mailbox changes: the wait answers with the account listed, as Partage does. */
  change(): void {
    const release = this.held;
    expect(release, 'a wait is held').not.toBeNull();
    this.held = null;
    this.seq++;
    release!(
      zimbraBody({
        WaitSetResponse: {
          waitSet: 'ws',
          seq: String(this.seq),
          a: [{ id: 'acc', changeid: String(100 + this.seq) }],
        },
      })
    );
  }

  /** The wait times out with no change. */
  idle(): void {
    const release = this.held;
    this.held = null;
    release!(zimbraBody({ WaitSetResponse: { waitSet: 'ws', seq: String(this.seq) } }));
  }

  answer = (r: FakeZimbra['requests'][number]): FakeZimbraAnswer | Promise<FakeZimbraAnswer> => {
    const name = r.soap?.name;
    const el = r.soap?.element ?? {};
    switch (name) {
      case 'AuthRequest':
        return zimbraBody({ AuthResponse: { authToken: [{ _content: 'tok' }] } });
      case 'GetInfoRequest':
        return zimbraBody({ GetInfoResponse: { name: ADDRESS } });
      case 'CreateWaitSetRequest': {
        const id = `ws${++this.created}`;
        this.waitSets.add(id);
        this.firstWaitOf.add(id);
        return zimbraBody({ CreateWaitSetResponse: { waitSet: id, defTypes: 'm', seq: '0' } });
      }
      case 'WaitSetRequest': {
        const ws = String(el.waitSet);
        if (!this.waitSets.has(ws)) return zimbraFault('admin.NO_SUCH_WAITSET');
        const first = this.firstWaitOf.delete(ws);
        if (first && this.cancelFirstWait) {
          this.waitSets.delete(ws);
          return zimbraBody({ WaitSetResponse: { waitSet: ws, seq: '0', canceled: true } });
        }
        return new Promise((answer) => (this.held = answer));
      }
      case 'DestroyWaitSetRequest':
        this.waitSets.delete(String(el.waitSet));
        return zimbraBody({ DestroyWaitSetResponse: {} });
      case 'SearchRequest': {
        expect(el).toMatchObject({
          query: 'inid:"2"',
          types: 'message',
          sortBy: 'idDesc',
          offset: 0,
        });
        const after = (el.cursor as { id?: string } | undefined)?.id;
        const inbox = this.items
          .filter((i) => (i.folder ?? '2') === '2')
          .sort((a, b) => num(b) - num(a))
          .filter((i) => after === undefined || num(i) < Number(after));
        const page = inbox.slice(0, Number(el.limit));
        return zimbraBody({
          SearchResponse: {
            more: page.length < inbox.length,
            m: page.map((i) => ({
              id: String(i.id),
              cid: `-${num(i)}`,
              l: '2',
              su: `Subject ${num(i)}`,
              d: num(i) * 1000,
              f: i.unread ? 'u' : '',
              e: [{ t: 'f', a: `s${num(i)}@emse.fr`, p: `Sender ${num(i)}` }],
            })),
          },
        });
      }
      case 'EndSessionRequest':
        return zimbraBody({ EndSessionResponse: {} });
      default:
        return zimbraBody({ [`${name?.replace('Request', 'Response')}`]: {} });
    }
  };
}

async function setup(store: MailCursorStore = webCursorStore(localStorage)) {
  const box = new Box();
  const zimbra = new FakeZimbra(box.answer);
  const session = new MailSession(new ZimbraSoapClient(zimbra.openStream), {
    userId: USER,
    deviceKey: () => KEY,
    mailAddress: async () => ADDRESS,
  });
  await session.signIn('pw', false);
  const notified: NewMail[][] = [];
  const pauses: number[] = [];
  const ended: string[] = [];
  /** Runs at each pause: a test that ends a failure streak does it HERE, since every fake answers
   *  in a microtask and a loop of failures would otherwise never yield to `vi.waitFor`. */
  const hooks: { onPause: ((count: number) => void) | null } = { onPause: null };
  const watcher = (): MailWatcher =>
    new MailWatcher({
      userId: USER,
      session,
      openWaitChannel: () => new ZimbraSoapClient(zimbra.openStream),
      notify: async (fresh) => {
        notified.push(fresh);
      },
      pause: async (ms) => {
        pauses.push(ms);
        hooks.onPause?.(pauses.length);
      },
      onRunEnded: (reason) => ended.push(reason),
      store,
    });
  const call: MailCall = (body) => session.call(body);
  return { box, zimbra, session, watcher, notified, pauses, ended, call, store, hooks };
}

const ids = (batches: NewMail[][]) => batches.map((b) => b.map((m) => m.id));
const cursorOf = () => readMailWatchCursor(USER, ADDRESS, webCursorStore(localStorage));

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('the new-mail watcher', () => {
  it('creates the wait set BEFORE it reads the inbox, then waits - so no change falls in a gap', async () => {
    const { box, zimbra, watcher } = await setup();
    box.items = [{ id: 10, unread: true }];
    const w = watcher();
    w.start();
    await vi.waitFor(() => expect(box.waiting).toBe(true));
    const names = zimbra.soapNames.filter((n) => n !== 'AuthRequest' && n !== 'GetInfoRequest');
    expect(names).toEqual(['CreateWaitSetRequest', 'SearchRequest', 'WaitSetRequest']);
    const wait = zimbra.requests.find((r) => r.soap?.name === 'WaitSetRequest')!;
    expect(wait.soap!.element).toMatchObject({ waitSet: 'ws1', seq: '0', block: 1, timeout: 60 });
    await w.stop('test');
  });

  it('takes a baseline on its first run: mail already there is not news', async () => {
    const { box, watcher, notified } = await setup();
    box.items = [
      { id: 10, unread: true },
      { id: 11, unread: true },
    ];
    const w = watcher();
    w.start();
    await vi.waitFor(() => expect(box.waiting).toBe(true));
    expect(notified).toEqual([]);
    expect(await cursorOf()).toEqual({ account: ADDRESS, highest: 11 });
    await w.stop('test');
  });

  it('one notification per new unread message, never twice across wakes, the next wait from the new seq', async () => {
    const { box, zimbra, watcher, notified } = await setup();
    box.items = [{ id: 10, unread: false }];
    const w = watcher();
    w.start();
    await vi.waitFor(() => expect(box.waiting).toBe(true));
    box.items.push({ id: 11, unread: true }, { id: 12, unread: true });
    box.change();
    await vi.waitFor(() => expect(ids(notified)).toEqual([['12', '11']]));
    await vi.waitFor(() => expect(box.waiting).toBe(true));
    const waits = zimbra.requests.filter((r) => r.soap?.name === 'WaitSetRequest');
    expect(waits.at(-1)!.soap!.element).toMatchObject({ seq: '1' });
    box.change();
    await vi.waitFor(() => expect(box.waiting).toBe(true));
    box.idle();
    await vi.waitFor(() => expect(box.waiting).toBe(true));
    expect(ids(notified)).toEqual([['12', '11']]);
    const first = notified[0][0];
    expect(first).toMatchObject({ conversationId: '-12', subject: 'Subject 12' });
    expect(first.from).toEqual({ address: 's12@emse.fr', name: 'Sender 12' });
    await w.stop('test');
  });

  it('a mail sent wakes it twice: the Sent copy is an empty delta, QUIET, and the delivery one notice', async () => {
    const { box, watcher, notified } = await setup();
    box.items = [{ id: 10, unread: false }];
    const warn = vi.spyOn(Log, 'w');
    const info = vi.spyOn(Log, 'i');
    const w = watcher();
    w.start();
    await vi.waitFor(() => expect(box.waiting).toBe(true));
    warn.mockClear();
    info.mockClear();
    box.items.push({ id: 11, unread: false, folder: '5' }); // the Sent copy
    box.change();
    await vi.waitFor(() => expect(box.waiting).toBe(true));
    expect(notified).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    box.items.push({ id: 12, unread: true }); // the delivery
    box.change();
    await vi.waitFor(() => expect(ids(notified)).toEqual([['12']]));
    expect(warn).not.toHaveBeenCalled();
    await w.stop('test');
  });

  it('never twice across a restart, and what came while it was stopped is notified at start', async () => {
    const { box, watcher, notified } = await setup();
    box.items = [{ id: 10, unread: true }];
    const first = watcher();
    first.start();
    await vi.waitFor(() => expect(box.waiting).toBe(true));
    box.items.push({ id: 11, unread: true });
    box.change();
    await vi.waitFor(() => expect(ids(notified)).toEqual([['11']]));
    await first.stop('the app was closed');

    box.items.push({ id: 12, unread: true });
    const second = watcher();
    second.start();
    await vi.waitFor(() => expect(ids(notified)).toEqual([['11'], ['12']]));
    await vi.waitFor(() => expect(box.waiting).toBe(true));
    expect(ids(notified)).toEqual([['11'], ['12']]);
    await second.stop('test');
  });

  it('a change that only reads, flags or moves mail notifies nothing', async () => {
    const { box, watcher, notified } = await setup();
    box.items = [
      { id: 10, unread: true },
      { id: 11, unread: true },
    ];
    const w = watcher();
    w.start();
    await vi.waitFor(() => expect(box.waiting).toBe(true));
    box.items[1].unread = false; // read on the webmail
    box.items[0].folder = '300'; // moved out of the inbox
    box.change();
    await vi.waitFor(() => expect(box.waiting).toBe(true));
    // A mail that ARRIVED but was read elsewhere before this device looked is not news either, and
    // the cursor still passes it.
    box.items.push({ id: 12, unread: false });
    box.change();
    await vi.waitFor(async () => expect((await cursorOf())?.highest).toBe(12));
    expect(notified).toEqual([]);
    await w.stop('test');
  });

  it('a wait set lapsed AFTER a normal wait is created again at once, nothing notified twice', async () => {
    const { box, watcher, notified, pauses } = await setup();
    box.items = [{ id: 10, unread: true }];
    const w = watcher();
    w.start();
    await vi.waitFor(() => expect(box.waiting).toBe(true));
    box.items.push({ id: 11, unread: true });
    box.change();
    await vi.waitFor(() => expect(ids(notified)).toEqual([['11']]));
    await vi.waitFor(() => expect(box.waiting).toBe(true));
    box.waitSets.clear();
    box.idle();
    await vi.waitFor(() => expect(box.created).toBe(2));
    await vi.waitFor(() => expect(box.waiting).toBe(true));
    expect(ids(notified)).toEqual([['11']]);
    expect(pauses).toEqual([]);
    await w.stop('test');
  });

  it('a wait set cancelled BEFORE any wait blocked is a failure of the ladder, never a free loop', async () => {
    const { box, watcher, pauses, hooks } = await setup();
    box.cancelFirstWait = true;
    hooks.onPause = (count) => {
      if (count === 2) box.cancelFirstWait = false;
    };
    const w = watcher();
    w.start();
    await vi.waitFor(() => expect(box.waiting).toBe(true));
    expect(pauses).toEqual([retryDelayMs(1), retryDelayMs(2)]);
    await w.stop('test');
  });

  it('a transport failure is retried after a rate-bounded pause, the inbox read again', async () => {
    const { box, zimbra, watcher, pauses } = await setup();
    box.items = [{ id: 10, unread: true }];
    const w = watcher();
    w.start();
    await vi.waitFor(() => expect(box.waiting).toBe(true));
    // The connection drops in the middle of the wait.
    zimbra.streams[zimbra.streams.length - 1].finish({ kind: 'peer_closed' });
    await vi.waitFor(() => expect(pauses).toEqual([retryDelayMs(1)]));
    await vi.waitFor(() => expect(box.waiting).toBe(true));
    expect(zimbra.soapNames.filter((n) => n === 'SearchRequest')).toHaveLength(2);
    await w.stop('test');
  });

  it('the delta is read over the run own connection, so a stop ends it too', async () => {
    const { box, zimbra, watcher } = await setup();
    box.items = [{ id: 10, unread: true }];
    const w = watcher();
    w.start();
    await vi.waitFor(() => expect(box.waiting).toBe(true));
    const carrying = (name: string) =>
      zimbra.streams.filter((s) => s.written.some((raw) => raw.includes(name)));
    const [run] = carrying('WaitSetRequest');
    // The delta and the wait ride ONE stream, the run's own: never the session's (the sign-in's).
    expect(carrying('SearchRequest')).toEqual([run]);
    expect(run).not.toBe(zimbra.streams[0]);
    await w.stop('test');
    expect(run.ended).toBe(true);
  });

  it('stop ends a wait in flight and releases the wait set over a spare connection', async () => {
    const { box, watcher, ended } = await setup();
    const w = watcher();
    w.start();
    await vi.waitFor(() => expect(box.waiting).toBe(true));
    await w.stop('the switch was turned off');
    expect(w.active).toBe(false);
    expect(box.waitSets.size).toBe(0);
    expect(ended).toEqual([]);
  });

  it('a signed-out mailbox ends the run, and the run says so', async () => {
    const { box, session, watcher, ended } = await setup();
    const w = watcher();
    w.start();
    await vi.waitFor(() => expect(box.waiting).toBe(true));
    await session.signOut();
    box.idle();
    await vi.waitFor(() => expect(w.active).toBe(false));
    expect(ended).toEqual(['the mailbox is signed_out']);
  });

  it('checkOnce reads the delta and notifies, without a wait', async () => {
    const { box, zimbra, watcher, notified } = await setup();
    box.items = [{ id: 10, unread: true }];
    const w = watcher();
    expect(await w.checkOnce()).toBe('done');
    box.items.push({ id: 11, unread: true });
    expect(await w.checkOnce()).toBe('done');
    expect(ids(notified)).toEqual([['11']]);
    expect(zimbra.soapNames).not.toContain('WaitSetRequest');
  });

  it('a cursor that cannot be written notifies nothing: the next read announces the mail, once', async () => {
    let refuse = true;
    const memory = webCursorStore(localStorage);
    const flaky: MailCursorStore = {
      read: (u) => memory.read(u),
      write: async (u, raw) => (refuse ? false : memory.write(u, raw)),
      erase: (u) => memory.erase(u),
    };
    const { box, watcher, notified } = await setup(flaky);
    refuse = false;
    box.items = [{ id: 10, unread: true }];
    const w = watcher();
    expect(await w.checkOnce()).toBe('done');
    box.items.push({ id: 11, unread: true });
    refuse = true;
    expect(await w.checkOnce()).toBe('done');
    expect(notified).toEqual([]);
    refuse = false;
    expect(await w.checkOnce()).toBe('done');
    expect(await w.checkOnce()).toBe('done');
    expect(ids(notified)).toEqual([['11']]);
  });
});

describe('the delta', () => {
  it('pages by id (Zimbra cursor, never an offset) until the cursor proves the rest old', async () => {
    const { box, call, store } = await setup();
    box.items = [{ id: 1, unread: true }];
    await readNewInboxMail(call, USER, ADDRESS, store);
    for (let id = 2; id <= 2 + 2 * DELTA_PAGE_SIZE + 9; id++) box.items.push({ id, unread: true });
    const read = await readNewInboxMail(call, USER, ADDRESS, store);
    expect(read.fresh).toHaveLength(2 * DELTA_PAGE_SIZE + 10);
    expect(new Set(read.fresh.map((m) => m.id)).size).toBe(read.fresh.length);
    expect(read.cursor.highest).toBe(2 + 2 * DELTA_PAGE_SIZE + 9);
    expect((await readNewInboxMail(call, USER, ADDRESS, store)).fresh).toEqual([]);
  });

  it('the baseline is the first NUMERIC id: an item of another mailbox shared in does not set it', async () => {
    const { box, call, store } = await setup();
    box.items = [
      { id: 'acc2:99', unread: true },
      { id: 7, unread: true },
    ];
    const read = await readNewInboxMail(call, USER, ADDRESS, store);
    expect(read.cursor.highest).toBe(7);
  });

  it("a cursor of another mailbox is not this one's: a new baseline", async () => {
    const { box, call, store } = await setup();
    box.items = [{ id: 7, unread: true }];
    localStorage.setItem(
      ACCOUNT_KEY.mailWatchCursor(USER),
      JSON.stringify({ v: 1, account: 'other@emse.fr', highest: 2 })
    );
    const read = await readNewInboxMail(call, USER, ADDRESS, store);
    expect(read).toMatchObject({ baseline: true, fresh: [] });
    expect(read.cursor.highest).toBe(7);
  });

  it('a session that moved during the read writes nothing and ends as not signed in', async () => {
    const { box, call, store } = await setup();
    box.items = [{ id: 3, unread: true }];
    await readNewInboxMail(call, USER, ADDRESS, store);
    box.items.push({ id: 4, unread: true });
    const err = await readNewInboxMail(call, USER, ADDRESS, store, () => false).catch((e) => e);
    expect(classifyMailFailure(err).kind).toBe('not_signed_in');
    expect((await cursorOf())?.highest).toBe(3);
  });

  it('the D8 erasure takes the cursor and the switch with the rest of the mail data', async () => {
    localStorage.setItem(
      ACCOUNT_KEY.mailWatchCursor(USER),
      JSON.stringify({ v: 1, account: ADDRESS, highest: 9 })
    );
    localStorage.setItem(ACCOUNT_KEY.mailNotifications(USER), '1');
    eraseMailLocalData(USER);
    expect(await cursorOf()).toBeNull();
    expect(localStorage.getItem(ACCOUNT_KEY.mailNotifications(USER))).toBeNull();
  });
});

describe('a connection closed while it opens (M2)', () => {
  it('is closed the moment it opens, and the call waiting on it fails as closed by us', async () => {
    let open!: (s: FakeStream) => void;
    const stream = new FakeStream();
    const client = new ZimbraSoapClient(() => new Promise((r) => (open = r)));
    const call = client.call({ NoOpRequest: {} });
    client.close();
    open(stream);
    const err = await call.catch((e) => e);
    expect(classifyMailFailure(err)).toMatchObject({ kind: 'transport', code: 'closed' });
    expect(stream.ended).toBe(true);
  });
});

describe('the wait timeout', () => {
  it('stays under the web relay idle close, with the overshoot measured on Partage', () => {
    const relay = readFileSync(
      resolve(import.meta.dirname, '../../../../apps/chat-gateway/src/mail_relay.rs'),
      'utf8'
    );
    const idle = /pub const IDLE_DEADLINE: Duration = Duration::from_secs\((\d+)\);/.exec(relay);
    expect(idle, 'IDLE_DEADLINE in mail_relay.rs').not.toBeNull();
    // Measured 2026-11-27: a 60 s wait answered after 63 s. Ten seconds of margin over that.
    const MEASURED_OVERSHOOT_S = 3;
    expect(WAIT_TIMEOUT_SECONDS + MEASURED_OVERSHOOT_S + 10).toBeLessThan(Number(idle![1]));
  });

  it('the retry pause doubles from 2 s and stops growing at 5 min', () => {
    expect([1, 2, 3, 8, 9, 50].map(retryDelayMs)).toEqual([
      2_000, 4_000, 8_000, 256_000, 300_000, 300_000,
    ]);
  });
});
