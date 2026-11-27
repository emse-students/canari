// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeZimbra, zimbraBody, zimbraFault } from '../../test/mailFakes';
import { MailApi } from './mailApi';
import { MailError } from './mailErrors';
import { MailSession } from './mailSession';
import { eligibilityOf, MailStore } from './mailStore.svelte';
import { ZimbraSoapClient } from './soapClient';

/**
 * The store the screens read: the folder list and the inbox badge, a paged list where an older
 * answer never lands on a newer list, the selection and bulk actions applied in place, and an empty
 * store once the account is closed (D8) or signed out.
 */

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(5)));
const ADDRESS = 'ada@etu.emse.fr';

function conv(id: string, flags: string) {
  return { id, su: `s${id}`, d: 1, n: 2, u: flags.includes('u') ? 1 : 0, f: flags, e: [] };
}

function setup() {
  let inboxUnread = 3;
  let closed = false;
  /** The conversations the server holds as read (every other one is unread). */
  const read: string[] = [];
  const zimbra = new FakeZimbra((r) => {
    const name = r.soap!.name;
    // An account the school deleted: its token stops working, and its own sign-in names it gone.
    if (closed) {
      return zimbraFault(
        name === 'AuthRequest' ? 'account.NO_SUCH_ACCOUNT' : 'service.AUTH_EXPIRED'
      );
    }
    if (name === 'AuthRequest')
      return zimbraBody({ AuthResponse: { authToken: [{ _content: 't' }] } });
    if (name === 'GetInfoRequest') return zimbraBody({ GetInfoResponse: { name: ADDRESS } });
    if (name === 'GetFolderRequest') {
      return zimbraBody({
        GetFolderResponse: {
          folder: [
            {
              id: '1',
              folder: [
                { id: '2', name: 'Inbox', n: 10, u: inboxUnread },
                { id: '3', name: 'Trash' },
                { id: '300', name: 'School' },
              ],
            },
          ],
        },
      });
    }
    if (name === 'SearchRequest') {
      const { query, offset } = r.soap!.element as { query: string; offset: number };
      const ids = query.includes('"300"') ? ['x1'] : offset === 0 ? ['c1', 'c2'] : ['c2', 'c3'];
      return zimbraBody({
        SearchResponse: {
          c: ids.map((id) => conv(id, read.includes(id) ? '' : 'u')),
          more: offset === 0 && ids.length === 2,
        },
      });
    }
    if (name === 'ConvActionRequest') {
      const action = r.soap!.element.action as { op: string; id: string };
      if (action.op === 'read') read.push(...action.id.split(','));
      inboxUnread = 0;
      return zimbraBody({ ConvActionResponse: {} });
    }
    return zimbraBody({});
  });
  const session = new MailSession(new ZimbraSoapClient(zimbra.openStream), {
    userId: 'u',
    deviceKey: () => KEY,
    mailAddress: async () => ADDRESS,
  });
  const api = new MailApi(session);
  const store = new MailStore(api, session, 2);
  return {
    zimbra,
    session,
    api,
    store,
    close: () => (closed = true),
  };
}

beforeEach(() => localStorage.clear());

describe('MailStore', () => {
  it('follows the session, and reads D1 from the address it names', async () => {
    const { session, store } = setup();
    expect(store.sessionState.kind).toBe('signed_out');
    expect(store.eligibility).toBe('unknown');
    // Before any mail sign-in, from the Canari account's own address.
    await store.loadEligibility();
    expect(store.identityEligibility).toBe('eligible');
    expect(store.eligibility).toBe('eligible');
    await session.signIn('pw', false);
    expect(store.sessionState.kind).toBe('ready');
    expect(store.eligibility).toBe('eligible');
    expect(
      eligibilityOf({ kind: 'needs_password', account: 'x@gmail.com', reason: 'not_remembered' })
    ).toBe('not_eligible');
  });

  it('loads the folders, the inbox badge, and the list page by page without duplicates', async () => {
    const { session, store } = setup();
    await session.signIn('pw', false);
    await store.refreshFolders();
    expect(store.inboxUnread).toBe(3);
    await store.openFolder('2');
    expect(store.currentFolder?.role).toBe('inbox');
    expect(store.conversations.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(store.hasMore).toBe(true);
    await store.loadMore();
    expect(store.conversations.map((c) => c.id)).toEqual(['c1', 'c2', 'c3']);
    expect(store.hasMore).toBe(false);
    await store.loadMore();
    expect(store.conversations).toHaveLength(3);
  });

  it('an answer for a list opened before the current one is dropped', async () => {
    const { session, store } = setup();
    await session.signIn('pw', false);
    const first = store.openFolder('2');
    const second = store.openFolder('300');
    await Promise.all([first, second]);
    expect(store.currentFolderId).toBe('300');
    expect(store.conversations.map((c) => c.id)).toEqual(['x1']);
  });

  it('a bulk action on the selection is ONE call, applied in place, then the badge reloads', async () => {
    const { zimbra, session, store } = setup();
    await session.signIn('pw', false);
    await store.refreshFolders();
    await store.openFolder('2');
    store.selectAll();
    expect(store.selected).toEqual(['c1', 'c2']);
    const searches = zimbra.soapNames.filter((n) => n === 'SearchRequest').length;
    await store.act('read');
    // The counts are the server's: the listed rows are read again, never guessed.
    expect(zimbra.soapNames.filter((n) => n === 'SearchRequest').length).toBe(searches + 1);
    expect(store.conversations.every((c) => !c.flags.unread && c.unreadCount === 0)).toBe(true);
    expect(store.selected).toEqual([]);
    expect(store.inboxUnread).toBe(0);
    const actions = zimbra.requests.filter((r) => r.soap?.name === 'ConvActionRequest');
    expect(actions.map((r) => r.soap!.element.action)).toEqual([
      { op: 'read', id: 'c1,c2', tcon: '-tjsd' },
    ]);

    store.toggle('c1');
    store.toggle('c2');
    store.toggle('c2');
    expect(store.selected).toEqual(['c1']);
    await store.act('trash');
    expect(store.conversations.map((c) => c.id)).toEqual(['c2']);
    await store.act('flag', ['c2']);
    expect(store.conversations[0].flags.flagged).toBe(true);
    await store.act('move', ['c2'], '300');
    expect(store.conversations).toEqual([]);
  });

  it('a closed account empties the store (D8), and the failed action is typed', async () => {
    const { session, store, close } = setup();
    await session.signIn('pw', true);
    await store.refreshFolders();
    await store.openFolder('2');
    close();
    await expect(store.act('trash', ['c1'])).rejects.toMatchObject({ kind: 'account_closed' });
    expect(store.sessionState.kind).toBe('closed');
    expect(store.folders).toEqual([]);
    expect(store.conversations).toEqual([]);
    expect(store.inboxUnread).toBe(0);
  });

  it('an action answered after the list changed, or a folder load after a reset, lands nothing (M11)', async () => {
    const { session, api, store } = setup();
    await session.signIn('pw', false);
    await store.openFolder('2');
    let fail!: (err: unknown) => void;
    const folders = vi
      .spyOn(api, 'folders')
      .mockReturnValueOnce(new Promise((_, reject) => (fail = reject)));
    const refreshing = store.refreshFolders();
    await session.signOut();
    fail(new MailError('not_signed_in', 'signed-out'));
    await refreshing;
    folders.mockRestore();
    expect(store.folders).toEqual([]);
    expect(store.error).toBeNull();

    await session.signIn('pw', false);
    await store.openFolder('2');
    const trashing = store.act('trash', ['c1']);
    await store.openFolder('300');
    await trashing;
    expect(store.conversations.map((c) => c.id)).toEqual(['x1']);
  });

  it('a sign-out empties it too', async () => {
    const { session, store } = setup();
    await session.signIn('pw', false);
    await store.openFolder('2');
    await session.signOut();
    expect(store.conversations).toEqual([]);
    expect(store.currentFolderId).toBeNull();
  });
});
