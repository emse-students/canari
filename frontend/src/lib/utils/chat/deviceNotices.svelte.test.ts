import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceEvent } from '$lib/mls-client/deviceTrust';
import { ACCOUNT_KEY } from '$lib/utils/accountLocalKeys';
import {
  deliverDeviceEvents,
  dismissDeviceNotice,
  dismissRefusedDeviceNotice,
  forgetDeviceNotices,
  loadDeviceNotices,
  noteRefusedOwnDevices,
  pendingDeviceNotices,
  pendingRefusedDeviceNotices,
  type DeviceNoticeContext,
} from './deviceNotices.svelte';

/**
 * User decision 2026-10-22: the owner is alerted (in the app, durably until seen) when a device
 * joins the account; a contact's new device is a discreet line in a DM or group - never in a
 * community or its key groups. A `pinned` re-add (resync, heal, kick and re-add under the same key)
 * and an audience `none` event produce nothing (#2268 review).
 */
const event = (over: Partial<DeviceEvent> = {}): DeviceEvent => ({
  groupId: 'dm-1',
  epoch: 5,
  identity: 'bob:web-2',
  keyFingerprint: '00ff',
  trust: 'first-sight',
  addedBy: 'bob:phone-1',
  memberAlreadyPresent: true,
  ...over,
});

/**
 * Alice's conversations: a DM and a group with bob, a group without him, a salon row and a
 * community key group he is in, and a DM with carol.
 */
const TREES: Record<string, string[]> = {
  'dm-1': ['alice:phone-a', 'bob:phone-1'],
  'group-1': ['alice:phone-a', 'bob:phone-1', 'carol:p'],
  'group-no-bob': ['alice:phone-a', 'carol:p'],
  'salon-1': ['alice:phone-a', 'bob:phone-1'],
  'community-key': ['alice:phone-a', 'BOB:phone-1'],
  'dm-carol': ['alice:phone-a', 'carol:p'],
};

function makeCtx(over: Partial<DeviceNoticeContext> = {}) {
  const conversations = new Map<string, { conversationType?: string; messages: { id: string }[] }>([
    ['dm-1', { conversationType: 'direct', messages: [] }],
    ['group-1', { conversationType: 'group', messages: [] }],
    ['group-no-bob', { conversationType: 'group', messages: [] }],
    ['salon-1', { conversationType: 'channel', messages: [] }],
    ['community-key', { conversationType: 'group', messages: [] }],
    ['dm-carol', { conversationType: 'direct', messages: [] }],
  ]);
  const addMessageToChat = vi.fn(
    async (_s: string, _c: string, convoKey: string, options?: { messageId?: string }) => {
      conversations.get(convoKey)?.messages.push({ id: options?.messageId ?? 'x' });
    }
  );
  const ctx: DeviceNoticeContext = {
    ownUserId: 'alice',
    ownDeviceId: 'phone-a',
    isDistributionGroup: (g) => g === 'community-key',
    conversations,
    memberIdentities: vi.fn(async (g: string) => {
      const tree = TREES[g];
      if (!tree) throw new Error(`group ${g} not held`);
      return tree;
    }),
    addMessageToChat,
    resolveDisplayNames: async () => (id: string) => (id === 'bob' ? 'Bob' : id),
    deviceLabel: async () => undefined,
    claimNative: vi.fn(async () => {}),
    now: () => 1_000,
    ...over,
  };
  return { ctx, addMessageToChat, conversations };
}

beforeEach(() => {
  localStorage.clear();
  forgetDeviceNotices();
  loadDeviceNotices('alice');
});
afterEach(() => forgetDeviceNotices());

/** The conversations a contact line was written in, in call order. */
const linesWrittenIn = (calls: unknown[][]) => calls.map((c) => c[2]);

describe('deliverDeviceEvents - the contact line', () => {
  it('writes one system line in every DM and group shared with the contact, idempotent', async () => {
    const { ctx, addMessageToChat } = makeCtx();
    await deliverDeviceEvents([event()], ctx);
    await deliverDeviceEvents([event()], ctx);
    expect(linesWrittenIn(addMessageToChat.mock.calls)).toEqual(['dm-1', 'group-1']);
    const [sender, content, , options] = addMessageToChat.mock.calls[0];
    expect(sender).toBe('system');
    expect(content).toContain('Bob');
    expect(options).toMatchObject({ isSystem: true });
  });

  it('a device first seen in a community still reaches the DM and group shared with its owner', async () => {
    const { ctx, addMessageToChat } = makeCtx();
    await deliverDeviceEvents([event({ groupId: 'community-key' })], ctx);
    expect(linesWrittenIn(addMessageToChat.mock.calls)).toEqual(['dm-1', 'group-1']);
  });

  it('writes NOTHING in a community key group, a salon, or a conversation without the contact', async () => {
    const { ctx, addMessageToChat } = makeCtx();
    await deliverDeviceEvents([event({ groupId: 'group-1' })], ctx);
    const written = linesWrittenIn(addMessageToChat.mock.calls);
    expect(written).not.toContain('community-key');
    expect(written).not.toContain('salon-1');
    expect(written).not.toContain('group-no-bob');
    expect(written).not.toContain('dm-carol');
  });

  it('a conversation whose tree this device does not hold is skipped, the others still written', async () => {
    const { ctx, addMessageToChat, conversations } = makeCtx();
    conversations.set('dm-gone', { conversationType: 'direct', messages: [] });
    await deliverDeviceEvents([event()], ctx);
    expect(linesWrittenIn(addMessageToChat.mock.calls)).toEqual(['dm-1', 'group-1']);
  });

  it('writes nothing for a pinned re-add, a member joining, or a joined-tree key change', async () => {
    const { ctx, addMessageToChat } = makeCtx();
    await deliverDeviceEvents(
      [
        event({ trust: 'pinned' }),
        event({ memberAlreadyPresent: false }),
        event({ trust: 'key-changed', addedBy: null }),
      ],
      ctx
    );
    expect(addMessageToChat).not.toHaveBeenCalled();
    expect(pendingDeviceNotices()).toEqual([]);
  });
});

describe('deliverDeviceEvents - the owner alert', () => {
  const own = event({ identity: 'alice:laptop-9', keyFingerprint: 'cc', addedBy: 'bob:phone-1' });

  it('records one durable alert per device and key, from any group, and claims it natively', async () => {
    const { ctx, addMessageToChat } = makeCtx({ deviceLabel: async () => 'Firefox on Linux' });
    await deliverDeviceEvents([own, { ...own, groupId: 'community-key' }], ctx);
    expect(addMessageToChat).not.toHaveBeenCalled();
    expect(pendingDeviceNotices()).toEqual([
      { key: 'alice:laptop-9|cc', deviceId: 'laptop-9', at: 1_000, label: 'Firefox on Linux' },
    ]);
    expect(ctx.claimNative).toHaveBeenCalledWith(['alice:laptop-9|cc']);

    // Survives a reload until seen.
    forgetDeviceNotices();
    loadDeviceNotices('alice');
    expect(pendingDeviceNotices()).toHaveLength(1);
  });

  it('is announced once: dismissed, the same device never comes back', async () => {
    const { ctx } = makeCtx();
    await deliverDeviceEvents([own], ctx);
    dismissDeviceNotice('alice:laptop-9|cc');
    await deliverDeviceEvents([own], ctx);
    expect(pendingDeviceNotices()).toEqual([]);
    expect(localStorage.getItem(ACCOUNT_KEY.deviceNotices('alice'))).toContain('laptop-9');
  });

  it('never alerts the added device about itself', async () => {
    const { ctx } = makeCtx({ ownDeviceId: 'laptop-9' });
    await deliverDeviceEvents([own], ctx);
    expect(pendingDeviceNotices()).toEqual([]);
  });

  it('an own device first seen in a community key group alerts the owner and writes no line', async () => {
    const { ctx, addMessageToChat } = makeCtx();
    await deliverDeviceEvents([{ ...own, groupId: 'community-key' }], ctx);
    expect(pendingDeviceNotices()).toHaveLength(1);
    expect(addMessageToChat).not.toHaveBeenCalled();
  });

  it('one failing event costs only itself', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { ctx, addMessageToChat } = makeCtx();
    addMessageToChat.mockRejectedValueOnce(new Error('db'));
    await deliverDeviceEvents([event(), own], ctx);
    expect(pendingDeviceNotices()).toHaveLength(1);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

/**
 * A device of MY account that this device refused for a changed key (`refusedDevices.ts`) cannot be
 * re-added to anything until it is reset - its owner is told so in the app, with the remedy. A
 * contact's refused device is not mine to be told about.
 */
describe('noteRefusedOwnDevices - the refused device of my own', () => {
  const labels = { deviceLabel: async (d: string) => (d === 'old' ? 'Pixel' : undefined) };

  it('tells the owner of an own refused device only, with its name', async () => {
    await noteRefusedOwnDevices(['ALICE:old', 'bob:x'], { ownUserId: 'alice', ...labels });
    expect(pendingRefusedDeviceNotices()).toEqual([
      { identity: 'alice:old', deviceId: 'old', label: 'Pixel' },
    ]);
  });

  it('stays until dismissed, and a dismissed one never comes back', async () => {
    await noteRefusedOwnDevices(['alice:old'], { ownUserId: 'alice', ...labels });
    forgetDeviceNotices();
    loadDeviceNotices('alice');
    await noteRefusedOwnDevices(['alice:old'], { ownUserId: 'alice', ...labels });
    expect(pendingRefusedDeviceNotices()).toHaveLength(1);

    dismissRefusedDeviceNotice('alice:old');
    forgetDeviceNotices();
    loadDeviceNotices('alice');
    await noteRefusedOwnDevices(['alice:old'], { ownUserId: 'alice', ...labels });
    expect(pendingRefusedDeviceNotices()).toEqual([]);
  });
});
