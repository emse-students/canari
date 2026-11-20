import { MlsDeliveryApi, serverDateOf, type MlsDeliveryFetch } from './mlsDeliveryApi';
import { resetServerClockForTests, serverTimeSeen } from '$lib/utils/chat/serverClock';
import {
  applyRenameFrame,
  pendingRenameVerdict,
  type PendingRename,
} from '$lib/utils/chat/groupName';
import type { Conversation } from '$lib/types';

/**
 * THE SERVER'S CLOCK ON A GROUP ROW READ (`GroupMeta.serverNow`): the rename sweep bounds a re-send
 * by it (`settleNameSync`), because every receiver measures its bound on the server's clock. Read
 * from the HTTP `Date` of the delivery service's OWN answer only - a portal's page states the
 * portal's time.
 */
const DATE = 'Tue, 17 Nov 2026 09:00:00 GMT';

function answering(headers: Record<string, string>, inits: (RequestInit | undefined)[] = []) {
  const fetchImpl: MlsDeliveryFetch = async (_input, init) => {
    inits.push(init);
    return new Response(JSON.stringify({ id: 'g1', name: 'n', isGroup: true }), {
      status: 200,
      headers,
    });
  };
  return new MlsDeliveryApi({
    historyUrl: 'https://test.local',
    getToken: async () => 'tok',
    fetchImpl,
  });
}

describe('the server clock a group row read carries', () => {
  it("is the Date of the delivery service's own answer", async () => {
    const meta = await answering({ 'content-type': 'application/json', date: DATE }).getGroupMeta(
      'g1'
    );
    expect(meta?.serverNow).toBe(Date.parse(DATE));
  });

  it('is absent when the answer states no readable Date', async () => {
    const meta = await answering({ 'content-type': 'application/json' }).getGroupMeta('g1');
    expect(meta).not.toBeNull();
    expect(meta?.serverNow).toBeUndefined();
  });

  it("is never read from an answer that is not the API's", async () => {
    const meta = await answering({ 'content-type': 'text/plain', date: DATE }).getGroupMeta('g1');
    expect(meta?.serverNow).toBeUndefined();
  });

  it('the typed status read carries it too, from a request no cache may answer', async () => {
    const inits: (RequestInit | undefined)[] = [];
    const status = await answering(
      { 'content-type': 'application/json', date: DATE },
      inits
    ).getGroupServerStatus('g1');
    expect(status).toMatchObject({ groupId: 'g1', serverNow: Date.parse(DATE) });
    expect(inits[0]?.cache).toBe('no-store');
  });

  it('reads nothing but a real date', () => {
    const at = (date?: string) =>
      serverDateOf({ headers: new Headers(date === undefined ? {} : { date }) });
    expect(at(DATE)).toBe(Date.parse(DATE));
    expect(at()).toBeUndefined();
    expect(at('not a date')).toBeUndefined();
  });
});

/**
 * ROUND 9: THE GROUP LIST'S `Date` BOUNDS EVERY NAME IT RETURNS. A row named from the list shows a
 * name whose frame was stamped before that answer, so the answer's `Date` is noted as a server time
 * - and a rename made over that undated name dates its base when the frame that set it replays,
 * even though this device never drained that frame before renaming.
 */
describe('the group list read notes the server clock', () => {
  function listing(headers: Record<string, string>) {
    const fetchImpl: MlsDeliveryFetch = async () =>
      new Response(JSON.stringify([{ groupId: 'g1', name: 'Old', isGroup: true }]), {
        status: 200,
        headers,
      });
    return new MlsDeliveryApi({
      historyUrl: 'https://test.local',
      getToken: async () => 'tok',
      fetchImpl,
    });
  }

  it("notes the API answer's Date, never a portal's", async () => {
    resetServerClockForTests();
    await listing({ 'content-type': 'text/html', date: DATE }).getUserGroups('round9-portal');
    expect(serverTimeSeen('round9-portal')).toBe(0);
    await listing({ 'content-type': 'application/json', date: DATE }).getUserGroups('round9-api');
    expect(serverTimeSeen('round9-api')).toBe(Date.parse(DATE));
  });

  it('a list dated D, then a replayed frame stamped <= D, dates the base: the sweep re-sends', async () => {
    resetServerClockForTests();
    const D = Date.parse(DATE);
    await listing({ 'content-type': 'application/json', date: DATE }).getUserGroups('round9-user');
    // The rename made over the undated "Old" the list named, on a link that never answered:
    // `renameGroupAndBroadcast` takes `serverTimeSeen` as the frame's `serverSeenAt`.
    const pending: PendingRename = {
      name: 'A',
      messageId: 'm-round9',
      sentAt: D + 60_000,
      over: { name: 'Old' },
      serverSeenAt: serverTimeSeen('round9-user'),
    };
    const held = {
      id: 'g1',
      name: 'Old',
      messages: [],
      conversationType: 'group',
      nameSync: { pending },
    } as unknown as Conversation;
    // The frame that set "Old" replays afterwards, stamped before the list answered.
    const outcome = applyRenameFrame(held, 'Old', D - 400, D - 500, 'bob');
    expect('row' in outcome).toBe(true);
    const row = (outcome as { row: Conversation }).row;
    expect(row.nameSync?.pending?.over).toEqual({ name: 'Old', at: D - 400 });
    expect(pendingRenameVerdict(row, row.nameSync!.pending!)).toBe('resend');
  });
});
