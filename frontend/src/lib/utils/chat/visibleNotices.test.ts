// @vitest-environment happy-dom
import { describe, expect, it, vi, type Mock } from 'vitest';
import { SvelteMap } from 'svelte/reactivity';

vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  globalMessaging: { isMessageCatchupActive: false, resetMessageCatchupState: vi.fn() },
}));
vi.mock('$lib/users/blocks', () => ({ isBlockedWith: vi.fn(async () => false) }));
// Names are a profile read nothing here is about: every id draws as itself.
vi.mock('$lib/utils/users/displayName', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/users/displayName')>()),
  resolveDisplayNames: async () => (id: string) => id,
}));

import { createMlsServiceStub } from '$lib/mls-client/test/fixtures/mlsServiceStub';
import { decodeAppMessage } from '$lib/proto/codec';
import type { StoredMessage } from '$lib/db';
import type { Conversation } from '$lib/types';
import {
  leaveGroupAndBroadcast,
  removeMemberAndBroadcast,
  renameGroupAndBroadcast,
  setGroupImageAndBroadcast,
} from './groupActions';
import { inviteMembersToGroup } from './groupCreation';
import { buildHistoryDigest, diffHistoryDigest, isEmptyHistoryDiff } from './historyManifest';
import { historyStateKey } from './historyStateKey';
import { sendVisibleNotice, type NoticeWriter } from './visibleNotices';
import { handleSystemEvent } from '$lib/mls-client/messagePipeline/systemMessageHandler';
import { applyReplaySystemEvent } from './historySystemEvents';

/**
 * THE ACTING DEVICE HOLDS ITS OWN NOTICE, UNDER THE ID EVERY MEMBER'S DEVICE WRITES.
 *
 * Found by the 1.4.1 dev campaign (4 draws in 10): Alice adds Bob; every other device writes the
 * `memberAdded` notice from the frame, under the id the sender minted, and Alice's device - which
 * MLS never hands its own frame - wrote nothing. Its history state key then differed from every
 * member's, the reconciliation's diff relayed the notice back, and Alice's device marked a row
 * authored by nobody "unverified". Each case here fails on that state.
 */

const GROUP = 'g-notices';
const ALICE = 'alice';
const AT = 1_700_000_000_000;

/** The frames the stub was asked to send, decoded, with the visible ones' ids. */
function sentFrames(mlsService: ReturnType<typeof createMlsServiceStub>) {
  return vi
    .mocked(mlsService.sendMessage)
    .mock.calls.map((call) => decodeAppMessage(call[1] as Uint8Array))
    .filter((f) => f?.system);
}

/** The one visible frame sent, and the row the acting device wrote for it. */
function frameAndOwnRow(
  mlsService: ReturnType<typeof createMlsServiceStub>,
  addMessageToChat: Mock<NoticeWriter>
) {
  const [frame] = sentFrames(mlsService);
  expect(addMessageToChat).toHaveBeenCalledTimes(1);
  const [senderId, , contactName, options] = addMessageToChat.mock.calls[0];
  const ownId = options?.messageId;
  expect(ownId).toBeTruthy();
  return { frame: frame!, senderId, contactName, options, ownId: ownId! };
}

/** The minimal store row a device holds for a notice - all the state key and the digest read. */
function noticeRow(id: string): StoredMessage {
  return {
    id,
    conversationId: GROUP,
    senderId: 'system',
    content: 'x',
    timestamp: AT,
  } as StoredMessage;
}

const AUTHORED = [
  { id: 'm-1', conversationId: GROUP, senderId: ALICE, content: 'x', timestamp: AT },
  { id: 'm-2', conversationId: GROUP, senderId: 'bob', content: 'x', timestamp: AT },
] as StoredMessage[];

function inviteDeps(addMessageToChat: Mock<NoticeWriter>) {
  const mlsService = createMlsServiceStub();
  vi.mocked(mlsService.fetchUserDevices).mockResolvedValue([{ deviceId: 'bob-dev' }] as never);
  vi.mocked(mlsService.acquireAddLock).mockResolvedValue(true);
  vi.mocked(mlsService.acquireAddLockAnswer).mockResolvedValue('taken');
  vi.mocked(mlsService.addMembersBulk).mockResolvedValue({
    addedDeviceIds: ['bob-dev'],
    skipped: [],
    welcome: new Uint8Array([1]),
  } as never);
  return {
    mlsService,
    deps: {
      mlsService,
      storage: null,
      userId: ALICE,
      deviceKeyB64: 'k',
      historyBaseUrl: 'https://example.invalid',
      conversations: new SvelteMap<string, Conversation>(),
      selectConversation: vi.fn(),
      saveConversation: vi.fn(async () => {}),
      addMessageToChat,
      log: vi.fn(),
    },
  };
}

describe('after Alice adds Bob', () => {
  it("Alice's own timeline holds the notice, under the id the frame carries to every member", async () => {
    const addMessageToChat = vi.fn<NoticeWriter>(async () => {});
    const { mlsService, deps } = inviteDeps(addMessageToChat);

    await inviteMembersToGroup(['bob'], { id: GROUP } as never, deps);

    const { frame, senderId, contactName, options } = frameAndOwnRow(mlsService, addMessageToChat);
    expect(frame.system?.event).toBe('memberAdded');
    expect(senderId).toBe('system');
    expect(contactName).toBe(GROUP);
    expect(options).toMatchObject({ isSystem: true, messageId: frame.messageId });
  });

  it("Alice's device and a member's describe the same history: one state key, an empty diff both ways", async () => {
    const addMessageToChat = vi.fn<NoticeWriter>(async () => {});
    const { mlsService, deps } = inviteDeps(addMessageToChat);
    await inviteMembersToGroup(['bob'], { id: GROUP } as never, deps);
    const { frame, ownId } = frameAndOwnRow(mlsService, addMessageToChat);

    // A member's device: the REAL live handler, fed the frame Alice sent.
    const memberId = await memberRowIdFor(frame);
    const alice = [...AUTHORED, noticeRow(ownId)];
    const member = [...AUTHORED, noticeRow(memberId)];

    expect(await historyStateKey(alice, 0)).toBe(await historyStateKey(member, 0));
    // Nothing to relay, so nothing to vet: no `[AUTHORSHIP] ... unverified` line can follow.
    const entries = (rows: StoredMessage[]) => rows.map((m) => ({ id: m.id, timestamp: AT }));
    const aliceSees = await diffHistoryDigest(
      entries(alice),
      await buildHistoryDigest(entries(member))
    );
    const memberSees = await diffHistoryDigest(
      entries(member),
      await buildHistoryDigest(entries(alice))
    );
    expect(isEmptyHistoryDiff(aliceSees)).toBe(true);
    expect(isEmptyHistoryDiff(memberSees)).toBe(true);
  });

  it('a digest from an older build that names the notice asks for nothing - nothing to loop on', async () => {
    const addMessageToChat = vi.fn<NoticeWriter>(async () => {});
    const { mlsService, deps } = inviteDeps(addMessageToChat);
    await inviteMembersToGroup(['bob'], { id: GROUP } as never, deps);
    const { frame, ownId } = frameAndOwnRow(mlsService, addMessageToChat);

    // An older member's device wrote the notice from the frame through the same handler.
    const olderDigest = await buildHistoryDigest(
      [...AUTHORED, noticeRow(await memberRowIdFor(frame))].map((m) => ({
        id: m.id,
        timestamp: AT,
      }))
    );
    const alice = [...AUTHORED, noticeRow(ownId)].map((m) => ({ id: m.id, timestamp: AT }));
    expect(isEmptyHistoryDiff(await diffHistoryDigest(alice, olderDigest))).toBe(true);
  });

  it('a local write that fails still reaches the checkpoint the send owes, and is not called a lost broadcast', async () => {
    const addMessageToChat = vi.fn<NoticeWriter>(async () => {
      throw new Error('store locked');
    });
    const { mlsService, deps } = inviteDeps(addMessageToChat);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await inviteMembersToGroup(['bob'], { id: GROUP } as never, deps);

    const sendOrder = vi.mocked(mlsService.sendMessage).mock.invocationCallOrder.at(-1)!;
    const checkpoints = vi.mocked(mlsService.persistCheckpoint).mock.invocationCallOrder;
    expect(checkpoints.some((at) => at > sendOrder)).toBe(true);
    expect(error.mock.calls.some((c) => String(c[0]).includes('was DELIVERED'))).toBe(true);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('Failed to broadcast'))).toBe(false);
    error.mockRestore();
    warn.mockRestore();
  });
});

const own = () => ({ contactName: GROUP, addMessageToChat: vi.fn<NoticeWriter>(async () => {}) });

describe('the other notices the acting device used to miss', () => {
  it('a rename', async () => {
    const mlsService = createMlsServiceStub();
    const ownNotice = own();
    await renameGroupAndBroadcast({
      mlsService,
      groupId: GROUP,
      newName: 'Nouveau nom',
      userId: ALICE,
      deviceKeyB64: 'k',
      ownNotice,
    });
    const { frame, options } = frameAndOwnRow(mlsService, ownNotice.addMessageToChat);
    expect(frame.system?.event).toBe('groupRenamed');
    expect(options).toMatchObject({ isSystem: true, messageId: frame.messageId });
  });

  it('a photo change', async () => {
    const mlsService = createMlsServiceStub();
    const ownNotice = own();
    await setGroupImageAndBroadcast({
      mlsService,
      groupId: GROUP,
      mediaId: 'media-1',
      userId: ALICE,
      deviceKeyB64: 'k',
      ownNotice,
    });
    const { frame, options } = frameAndOwnRow(mlsService, ownNotice.addMessageToChat);
    expect(frame.system?.event).toBe('groupImageChanged');
    expect(options).toMatchObject({ isSystem: true, messageId: frame.messageId });
  });

  it('a removal (its race endings: groupActions.removeRace.test.ts)', async () => {
    const mlsService = createMlsServiceStub();
    // Bob holds a leaf at the server's epoch until this device's Remove commits.
    let tree = [`${ALICE}:da`, 'bob:d1'];
    vi.mocked(mlsService.getEpoch).mockReturnValue(3);
    vi.mocked(mlsService.getGroupMemberIdentities).mockImplementation(async () => [...tree]);
    vi.mocked(mlsService.fetchCommitsSince).mockResolvedValue({
      commits: [],
      activeEpoch: 3,
      belowFloor: false,
    } as never);
    vi.mocked(mlsService.removeMember).mockImplementation(async () => {
      tree = [`${ALICE}:da`];
    });
    const ownNotice = own();
    await removeMemberAndBroadcast({
      mlsService,
      groupId: GROUP,
      memberId: 'bob',
      userId: ALICE,
      deviceKeyB64: 'k',
      ownNotice,
    });
    const { frame, options } = frameAndOwnRow(mlsService, ownNotice.addMessageToChat);
    expect(frame.system?.event).toBe('memberRemoved');
    expect(options).toMatchObject({ isSystem: true, messageId: frame.messageId });
  });

  it('writes nothing when the frame was not accepted - a row only this device holds diverges too', async () => {
    const mlsService = createMlsServiceStub();
    vi.mocked(mlsService.sendMessage).mockRejectedValue(new Error('offline'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ownNotice = own();
    await renameGroupAndBroadcast({
      mlsService,
      groupId: GROUP,
      newName: 'Nouveau nom',
      userId: ALICE,
      deviceKeyB64: 'k',
      ownNotice,
    });
    expect(ownNotice.addMessageToChat).not.toHaveBeenCalled();
  });

  it('a departure still sends its frame and writes no row: no device of the leaver draws it', async () => {
    const mlsService = createMlsServiceStub();
    await leaveGroupAndBroadcast({ mlsService, groupId: GROUP, userId: ALICE, deviceKeyB64: 'k' });
    expect(sentFrames(mlsService)[0]?.system?.event).toBe('memberLeft');

    // And handed a writer, the departure and the deletion still write nothing.
    for (const event of ['memberLeft', 'groupDeleted'] as const) {
      const writer = own();
      await sendVisibleNotice(
        createMlsServiceStub(),
        GROUP,
        event,
        { userId: ALICE },
        {
          ...writer,
          actor: ALICE,
        }
      );
      expect(writer.addMessageToChat).not.toHaveBeenCalled();
    }
  });

  it('a failed LOCAL write is not thrown as a failed send', async () => {
    const writer = {
      contactName: GROUP,
      actor: ALICE,
      addMessageToChat: vi.fn<NoticeWriter>(async () => {
        throw new Error('store locked');
      }),
    };
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      sendVisibleNotice(createMlsServiceStub(), GROUP, 'groupRenamed', { newName: 'x' }, writer)
    ).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });
});

describe('the archive replay draws the photo notice too', () => {
  it('under the frame id, like the live path', async () => {
    const mlsService = createMlsServiceStub();
    await setGroupImageAndBroadcast({
      mlsService,
      groupId: GROUP,
      mediaId: 'media-1',
      userId: ALICE,
      deviceKeyB64: 'k',
      ownNotice: own(),
    });
    const [frame] = sentFrames(mlsService);
    const pushed: Array<{ messageId?: string; senderId: string }> = [];
    await applyReplaySystemEvent({
      parsed: { system: frame!.system, messageId: frame!.messageId ?? '' },
      msg: { sender_id: ALICE, timestamp: '2026-10-25T10:00:00.000Z' },
      contactName: GROUP,
      userId: 'bob',
      conversationId: GROUP,
      getConversation: () => ({ id: GROUP, messages: [] }),
      setConversation: vi.fn(),
      messageReactions: new Map(),
      reactionUpdates: new Map(),
      deletedMessages: new Map(),
      editedMessages: new Map(),
      readWatermarkUpdates: {},
      serverReadWatermarkUpdates: {},
      historyFloorUpdate: { at: 0 },
      pushPendingMessage: (entry: { messageId?: string; senderId: string }) => pushed.push(entry),
      dropOwnExcluded: async (messages: unknown) => messages,
    } as never);
    expect(pushed).toHaveLength(1);
    expect(pushed[0].messageId).toBe(frame!.messageId);
  });
});

/** The id a member's device writes for `frame`, through the real live handler. */
async function memberRowIdFor(frame: NonNullable<ReturnType<typeof decodeAppMessage>>) {
  const addMessageToChat = vi.fn(async () => {});
  const convo = { id: GROUP, lifecycle: 'active', messages: [], name: 'Groupe' };
  await handleSystemEvent(frame.system!.event!, JSON.parse(frame.system!.data || '{}'), {
    mlsService: {},
    storage: null,
    userId: 'bob',
    deviceKey: () => 'device-key',
    conversations: new Map([[GROUP, convo]]),
    messageReactions: new Map(),
    addMessageToChat,
    batchAddMessages: vi.fn(),
    deleteConversation: vi.fn(),
    saveConversation: vi.fn(async () => {}),
    getSelectedContact: () => GROUP,
    setSelectedContact: vi.fn(),
    onReadStateAdvanced: vi.fn(),
    log: vi.fn(),
    convo,
    convoKey: GROUP,
    senderNorm: ALICE,
    messageId: frame.messageId ?? undefined,
    persistMlsStateNow: vi.fn(),
  } as never);
  const calls = addMessageToChat.mock.calls as unknown as Array<
    [string, string, string, { messageId: string }]
  >;
  expect(calls).toHaveLength(1);
  return calls[0][3].messageId;
}
