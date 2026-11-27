// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeZimbra, zimbraBody, zimbraFault, type FakeZimbraAnswer } from '../../test/mailFakes';
import { ACCOUNT_KEY } from '$lib/utils/accountLocalKeys';
import { MailApi } from './mailApi';
import { eraseMailLocalData } from './mailLocalData';
import { MailSession } from './mailSession';
import { readMailWatchCursor } from './mailWatchCursor';
import {
  DELTA_PAGE_SIZE,
  MailWatcher,
  WAIT_TIMEOUT_SECONDS,
  readNewInboxMail,
  retryDelayMs,
  type NewMail,
} from './mailWatcher';
import { ZimbraSoapClient } from './soapClient';

/**
 * The new-mail watcher over a fake Partage (lot 4): a change is one notification per new unread
 * message, never twice - not across a wake, not across a restart (the cursor) - nothing for a change
 * that only reads or flags, the wait set created before the inbox is read, and the D8 erasure takes
 * the cursor.
 */

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(5)));
const ADDRESS = 'ada@etu.emse.fr';
const USER = 'u1';

interface Item {
  id: number;
  unread: boolean;
  /** A folder other than the inbox (2) is not listed by the inbox search. */
  folder?: string;
}

/** A fake mailbox: the inbox, the wait sets, and a wait the test releases. */
class Box {
  items: Item[] = [];
  waitSets = new Set<string>();
  created = 0;
  seq = 0;
  private held: ((answer: FakeZimbraAnswer) => void) | null = null;

  get waiting(): boolean {
    return this.held !== null;
  }

  /** The mailbox changes: the wait answers with the account listed. */
  change(): void {
    const release = this.held;
    expect(release, 'a wait is held').not.toBeNull();
    this.held = null;
    this.seq++;
    release!(
      zimbraBody({ WaitSetResponse: { waitSet: 'ws', seq: String(this.seq), a: [{ id: 'acc' }] } })
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
        return zimbraBody({ CreateWaitSetResponse: { waitSet: id, defTypes: 'm', seq: 0 } });
      }
      case 'WaitSetRequest':
        if (!this.waitSets.has(String(el.waitSet))) return zimbraFault('admin.NO_SUCH_WAITSET');
        return new Promise((answer) => (this.held = answer));
      case 'DestroyWaitSetRequest':
        this.waitSets.delete(String(el.waitSet));
        return zimbraBody({ DestroyWaitSetResponse: {} });
      case 'SearchRequest': {
        expect(el).toMatchObject({ query: 'inid:"2"', types: 'message', sortBy: 'idDesc' });
        const inbox = this.items
          .filter((i) => (i.folder ?? '2') === '2')
          .sort((a, b) => b.id - a.id);
        const offset = Number(el.offset);
        const page = inbox.slice(offset, offset + Number(el.limit));
        return zimbraBody({
          SearchResponse: {
            more: offset + page.length < inbox.length,
            m: page.map((i) => ({
              id: String(i.id),
              cid: `-${i.id}`,
              l: '2',
              su: `Subject ${i.id}`,
              d: i.id * 1000,
              f: i.unread ? 'u' : '',
              e: [{ t: 'f', a: `s${i.id}@emse.fr`, p: `Sender ${i.id}` }],
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

async function setup() {
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
  const watcher = (): MailWatcher =>
    new MailWatcher({
      userId: USER,
      session,
      api: new MailApi(session),
      openWaitChannel: () => new ZimbraSoapClient(zimbra.openStream),
      notify: async (fresh) => {
        notified.push(fresh);
      },
      pause: async (ms) => {
        pauses.push(ms);
      },
    });
  return { box, zimbra, session, watcher, notified, pauses };
}

const ids = (batches: NewMail[][]) => batches.map((b) => b.map((m) => m.id));

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
    expect(readMailWatchCursor(USER, ADDRESS)).toEqual({ account: ADDRESS, highest: 11 });
    await w.stop('test');
  });

  it('one notification per new unread message, and never twice across wakes', async () => {
    const { box, watcher, notified } = await setup();
    box.items = [{ id: 10, unread: false }];
    const w = watcher();
    w.start();
    await vi.waitFor(() => expect(box.waiting).toBe(true));
    box.items.push({ id: 11, unread: true }, { id: 12, unread: true });
    box.change();
    await vi.waitFor(() => expect(ids(notified)).toEqual([['12', '11']]));
    await vi.waitFor(() => expect(box.waiting).toBe(true));
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
    await vi.waitFor(() => expect(readMailWatchCursor(USER, ADDRESS)?.highest).toBe(12));
    expect(notified).toEqual([]);
    await w.stop('test');
  });

  it('a lapsed wait set is created again at once, with nothing notified twice', async () => {
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

  it('stop ends a wait in flight and releases the wait set', async () => {
    const { box, watcher } = await setup();
    const w = watcher();
    w.start();
    await vi.waitFor(() => expect(box.waiting).toBe(true));
    await w.stop('the switch was turned off');
    expect(w.active).toBe(false);
    expect(box.waitSets.size).toBe(0);
  });

  it('a signed-out mailbox ends the run', async () => {
    const { box, session, watcher } = await setup();
    const w = watcher();
    w.start();
    await vi.waitFor(() => expect(box.waiting).toBe(true));
    await session.signOut();
    box.idle();
    await vi.waitFor(() => expect(w.active).toBe(false));
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
});

describe('the delta', () => {
  it('pages by id until the cursor proves the rest old', async () => {
    const { box, session } = await setup();
    box.items = [{ id: 1, unread: true }];
    const api = new MailApi(session);
    await readNewInboxMail(api, USER, ADDRESS);
    for (let id = 2; id <= 2 + 2 * DELTA_PAGE_SIZE + 9; id++) box.items.push({ id, unread: true });
    const read = await readNewInboxMail(api, USER, ADDRESS);
    expect(read.fresh).toHaveLength(2 * DELTA_PAGE_SIZE + 10);
    expect(new Set(read.fresh.map((m) => m.id)).size).toBe(read.fresh.length);
    expect(read.cursor.highest).toBe(2 + 2 * DELTA_PAGE_SIZE + 9);
    expect((await readNewInboxMail(api, USER, ADDRESS)).fresh).toEqual([]);
  });

  it("a cursor of another mailbox is not this one's: a new baseline", async () => {
    const { box, session } = await setup();
    box.items = [{ id: 7, unread: true }];
    localStorage.setItem(
      ACCOUNT_KEY.mailWatchCursor(USER),
      JSON.stringify({ v: 1, account: 'other@emse.fr', highest: 2 })
    );
    const read = await readNewInboxMail(new MailApi(session), USER, ADDRESS);
    expect(read).toMatchObject({ baseline: true, fresh: [] });
    expect(read.cursor.highest).toBe(7);
  });

  it('the D8 erasure takes the cursor and the switch with the rest of the mail data', () => {
    localStorage.setItem(
      ACCOUNT_KEY.mailWatchCursor(USER),
      JSON.stringify({ v: 1, account: ADDRESS, highest: 9 })
    );
    localStorage.setItem(ACCOUNT_KEY.mailNotifications(USER), '1');
    eraseMailLocalData(USER);
    expect(readMailWatchCursor(USER, ADDRESS)).toBeNull();
    expect(localStorage.getItem(ACCOUNT_KEY.mailNotifications(USER))).toBeNull();
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
