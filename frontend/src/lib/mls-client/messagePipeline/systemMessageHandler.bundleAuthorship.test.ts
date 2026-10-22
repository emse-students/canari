import { afterEach } from 'vitest';
import { handleSystemEvent } from './systemMessageHandler';
import {
  keySource,
  newTestAuthor,
  signedBy,
  type TestAuthor,
} from '$lib/crypto/messageAuthorship.testKit';
import { mkSystem } from '$lib/proto/codec';
import { mkTextEnvelope, serializeEnvelope } from '$lib/envelope';
import {
  recordedIntegrityFindings,
  resetIntegrityFindings,
} from '$lib/mls-client/integrityFindings';

/**
 * A `history_bundle` from MALLORY, a member, about ALICE's messages - the attack the author proofs
 * close (history-reconciliation, "Restored history carries its author's signature"). Before them,
 * every one of these changed the receiving device's history on mallory's word alone.
 */
const ME = 'me';
const GROUP = 'g1';
const SENT_AT = 1_700_000_000_000;
const HELLO = { messageId: 'm1', sentAt: SENT_AT, text: { content: 'hello' } };
const helloContent = serializeEnvelope(mkTextEnvelope('hello'));

afterEach(() => resetIntegrityFindings());

function makeCtx(alice: TestAuthor, mallory: TestAuthor, held: Record<string, unknown>[] = []) {
  const conversations = new Map<string, any>();
  conversations.set(GROUP, { id: GROUP, unreadCount: 0, messages: held });
  const keys = keySource({ tree: [alice, mallory] });
  return {
    mlsService: {
      ...keys,
      getDeviceId: () => 'device-me',
      getGroupWithheld: vi.fn().mockResolvedValue(new Map([[ME, []]])),
    },
    storage: { updateMessage: vi.fn().mockResolvedValue(undefined) },
    userId: ME,
    deviceKey: () => 'device-key',
    conversations,
    messageReactions: new Map(),
    addMessageToChat: vi.fn(),
    batchAddMessages: vi.fn(),
    deleteConversation: vi.fn(),
    saveConversation: vi.fn().mockResolvedValue(undefined),
    getSelectedContact: () => null,
    setSelectedContact: vi.fn(),
    onReadStateAdvanced: vi.fn(),
    log: vi.fn(),
    convo: conversations.get(GROUP),
    convoKey: GROUP,
    senderNorm: 'mallory',
    persistMlsStateNow: vi.fn(),
  };
}

async function cast() {
  return {
    alice: await newTestAuthor('alice:dev-a'),
    mallory: await newTestAuthor('mallory:dev-m'),
  };
}

function added(ctx: ReturnType<typeof makeCtx>): any[] {
  return ctx.batchAddMessages.mock.calls.flatMap((c) => c[0]);
}

describe('history_bundle - restored history carries its author signature', () => {
  it('REFUSES a message forged in another member name, and records the finding', async () => {
    const { alice, mallory } = await cast();
    const ctx = makeCtx(alice, mallory);
    const authorship = await signedBy(mallory, GROUP, HELLO, { claim: 'alice:dev-a' });

    await handleSystemEvent(
      'history_bundle',
      {
        messages: [
          { id: 'm1', senderId: 'alice', content: helloContent, timestamp: SENT_AT, authorship },
        ],
      },
      ctx as any
    );

    expect(added(ctx)).toEqual([]);
    expect(recordedIntegrityFindings()).toEqual([
      expect.objectContaining({
        kind: 'forged-history',
        groupId: GROUP,
        peer: 'mallory',
        detail: 'message',
      }),
    ]);
  });

  it('takes a relayed message from its author signed bytes, not from the relayer fields', async () => {
    const { alice, mallory } = await cast();
    const ctx = makeCtx(alice, mallory);
    const authorship = await signedBy(alice, GROUP, HELLO);

    await handleSystemEvent(
      'history_bundle',
      {
        messages: [
          {
            id: 'm1',
            senderId: 'alice',
            content: 'words alice never wrote',
            timestamp: 1,
            authorship,
          },
        ],
      },
      ctx as any
    );

    expect(added(ctx)).toEqual([
      expect.objectContaining({
        messageId: 'm1',
        senderId: 'alice',
        content: helloContent,
        timestamp: new Date(SENT_AT),
        authorship,
      }),
    ]);
    expect(added(ctx)[0].restoredUnverified).toBeUndefined();
  });

  it('keeps an unsigned message relayed by someone else, MARKED as unverified', async () => {
    const { alice, mallory } = await cast();
    const ctx = makeCtx(alice, mallory);

    await handleSystemEvent(
      'history_bundle',
      { messages: [{ id: 'm1', senderId: 'alice', content: helloContent, timestamp: SENT_AT }] },
      ctx as any
    );

    expect(added(ctx)).toEqual([
      expect.objectContaining({ messageId: 'm1', restoredUnverified: true }),
    ]);
  });

  it('no longer lets another member tombstone a message this device holds', async () => {
    const { alice, mallory } = await cast();
    const held = {
      id: 'm1',
      senderId: 'alice',
      content: helloContent,
      timestamp: new Date(SENT_AT),
    };
    const ctx = makeCtx(alice, mallory, [held]);

    await handleSystemEvent(
      'history_bundle',
      {
        messages: [
          { id: 'm1', senderId: 'alice', content: 'deleted', timestamp: SENT_AT, isDeleted: true },
        ],
      },
      ctx as any
    );

    expect(ctx.conversations.get(GROUP).messages[0].isDeleted).toBeUndefined();
    expect(ctx.conversations.get(GROUP).messages[0].content).toBe(helloContent);
  });

  it('applies a tombstone the author signed, whoever relays it, and purges the original bytes', async () => {
    const { alice, mallory } = await cast();
    const held = {
      id: 'm1',
      senderId: 'alice',
      content: helloContent,
      timestamp: new Date(SENT_AT),
    };
    const ctx = makeCtx(alice, mallory, [held]);
    const deleteProof = await signedBy(
      alice,
      GROUP,
      mkSystem('delete_message', JSON.stringify({ messageId: 'm1' }))
    );

    await handleSystemEvent(
      'history_bundle',
      {
        messages: [
          {
            id: 'm1',
            senderId: 'alice',
            content: 'deleted',
            timestamp: SENT_AT,
            isDeleted: true,
            deleteProof,
          },
        ],
      },
      ctx as any
    );

    expect(ctx.conversations.get(GROUP).messages[0].isDeleted).toBe(true);
    expect(ctx.storage.updateMessage).toHaveBeenCalledWith(
      'm1',
      expect.objectContaining({ isDeleted: true, deleteProof, authorship: null, editProof: null }),
      'device-key'
    );
  });

  it('applies an edit the author signed, whoever relays it', async () => {
    const { alice, mallory } = await cast();
    const held = {
      id: 'm1',
      senderId: 'alice',
      content: helloContent,
      timestamp: new Date(SENT_AT),
    };
    const ctx = makeCtx(alice, mallory, [held]);
    const editProof = await signedBy(
      alice,
      GROUP,
      mkSystem(
        'edit_message',
        JSON.stringify({ messageId: 'm1', newContent: 'fixed', editedAt: 9000 })
      )
    );

    await handleSystemEvent(
      'history_bundle',
      {
        messages: [
          {
            id: 'm1',
            senderId: 'alice',
            content: 'anything',
            timestamp: SENT_AT,
            isEdited: true,
            editedAt: 9000,
            editProof,
          },
        ],
      },
      ctx as any
    );

    const row = ctx.conversations.get(GROUP).messages[0];
    expect(row.content).toBe(serializeEnvelope(mkTextEnvelope('fixed')));
    expect(row.editedAt).toEqual(new Date(9000));
  });

  it('drops reactions placed in another member name without that member signature', async () => {
    const { alice, mallory } = await cast();
    const held = {
      id: 'm1',
      senderId: 'alice',
      content: helloContent,
      timestamp: new Date(SENT_AT),
    };
    const ctx = makeCtx(alice, mallory, [held]);

    await handleSystemEvent(
      'history_bundle',
      {
        messages: [
          {
            id: 'm1',
            senderId: 'alice',
            content: helloContent,
            timestamp: SENT_AT,
            reactions: [
              { userId: 'alice', emoji: '💩', at: 5 },
              { userId: 'mallory', emoji: '🔥', at: 6 },
            ],
          },
        ],
      },
      ctx as any
    );

    expect(ctx.messageReactions.get('m1')?.map((r: any) => r.emoji)).toEqual(['🔥']);
  });
});
