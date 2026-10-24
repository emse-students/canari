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
import { fromMessagePayload, mergeStoredMessage, toMessagePayload } from '$lib/db/messagePayload';
import {
  recordedIntegrityFindings,
  resetIntegrityFindings,
} from '$lib/mls-client/integrityFindings';

/**
 * A `history_bundle` from MALLORY, a member, about ALICE's messages: what the receiving device takes
 * from it (history-reconciliation, "Restored history carries its author's signature").
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
  it('never verifies a message signed in another member name - kept, MARKED, no accusation', async () => {
    // The key that fails to verify may be a re-Welcome leaf, not the one alice signed with, so it
    // may not accuse: the row reads exactly as an unsigned one.
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

    expect(added(ctx)).toEqual([
      expect.objectContaining({ messageId: 'm1', restoredUnverified: true }),
    ]);
    expect(recordedIntegrityFindings()).toEqual([]);
  });

  it('REFUSES a message whose proof is malformed, and records the finding', async () => {
    const { alice, mallory } = await cast();
    const ctx = makeCtx(alice, mallory);
    const signed = await signedBy(alice, GROUP, HELLO);
    const authorship = { ...signed, proof: 'AAAA' };

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

  it('takes a tombstone of a held message only from its author', async () => {
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

  it('keeps the mark on a row its relayer holds only as unverified, even when the row names the relayer', async () => {
    const { alice, mallory } = await cast();
    const ctx = { ...makeCtx(alice, mallory), senderNorm: 'alice' };

    await handleSystemEvent(
      'history_bundle',
      {
        messages: [
          {
            id: 'm1',
            senderId: 'alice',
            content: helloContent,
            timestamp: SENT_AT,
            authorUnproven: true,
          },
        ],
      },
      ctx as any
    );

    expect(added(ctx)).toEqual([
      expect.objectContaining({ messageId: 'm1', restoredUnverified: true }),
    ]);
  });

  it('never takes an edited body its relayer holds only as unverified, even from the named author', async () => {
    const { alice, mallory } = await cast();
    const held = {
      id: 'm1',
      senderId: 'alice',
      content: helloContent,
      timestamp: new Date(SENT_AT),
    };
    const ctx = { ...makeCtx(alice, mallory, [held]), senderNorm: 'alice' };

    await handleSystemEvent(
      'history_bundle',
      {
        messages: [
          {
            id: 'm1',
            senderId: 'alice',
            content: serializeEnvelope(mkTextEnvelope('words alice never wrote')),
            timestamp: SENT_AT,
            isEdited: true,
            editedAt: 9000,
            authorUnproven: true,
          },
        ],
      },
      ctx as any
    );

    expect(ctx.conversations.get(GROUP).messages[0].content).toBe(helloContent);
  });

  it('upgrades a held UNVERIFIED row when a copy whose proof verifies arrives, and clears the mark', async () => {
    const { alice, mallory } = await cast();
    const held = {
      id: 'm1',
      senderId: 'alice',
      content: 'words alice never wrote',
      timestamp: new Date(1),
      restoredUnverified: true,
    };
    const ctx = makeCtx(alice, mallory, [held]);
    const authorship = await signedBy(alice, GROUP, HELLO);

    await handleSystemEvent(
      'history_bundle',
      {
        messages: [{ id: 'm1', senderId: 'alice', content: 'anything', timestamp: 1, authorship }],
      },
      ctx as any
    );

    const row = ctx.conversations.get(GROUP).messages[0];
    expect(row.content).toBe(helloContent);
    expect(row.timestamp).toEqual(new Date(SENT_AT));
    expect(row.restoredUnverified).toBeFalsy();
    expect(ctx.storage.updateMessage).toHaveBeenCalledWith(
      'm1',
      expect.objectContaining({ content: helloContent, authorship, restoredUnverified: false }),
      'device-key'
    );
    expect(added(ctx)).toEqual([]);
  });

  it('an upgrade replaces the unverified row ENTIRELY - the sender comes from the proof', async () => {
    // The marked row names mallory under an id alice's signed message carries: its sender was a
    // relayer's word like its body, and must not survive the proof.
    const { alice, mallory } = await cast();
    const held = {
      id: 'm1',
      senderId: 'mallory',
      content: 'words nobody signed',
      timestamp: new Date(1),
      restoredUnverified: true,
      isEdited: true,
      editedAt: new Date(5),
    };
    const ctx = makeCtx(alice, mallory, [held]);
    const authorship = await signedBy(alice, GROUP, HELLO);

    await handleSystemEvent(
      'history_bundle',
      { messages: [{ id: 'm1', senderId: 'alice', content: 'x', timestamp: 1, authorship }] },
      ctx as any
    );

    const row = ctx.conversations.get(GROUP).messages[0];
    expect(row.senderId).toBe('alice');
    expect(row.content).toBe(helloContent);
    expect(row.isEdited).toBeFalsy();
    expect(row.editedAt).toBeUndefined();
    const patch = ctx.storage.updateMessage.mock.calls.find((c: any[]) => c[0] === 'm1')?.[1];
    expect(patch).toEqual(
      expect.objectContaining({
        senderId: 'alice',
        content: helloContent,
        authorship,
        restoredUnverified: false,
        isEdited: false,
        editedAt: null,
        editProof: null,
      })
    );
    // And after a reload: the stored row carries none of the unproven edit state.
    const reloaded = fromMessagePayload(
      { id: 'm1', conversationId: GROUP, timestamp: SENT_AT },
      toMessagePayload(
        mergeStoredMessage(
          {
            id: 'm1',
            conversationId: GROUP,
            senderId: 'mallory',
            content: 'words nobody signed',
            timestamp: 1,
            restoredUnverified: true,
            isEdited: true,
            editedAt: 5,
          },
          patch
        )
      )
    );
    expect(reloaded).toEqual(
      expect.objectContaining({ senderId: 'alice', content: helloContent, authorship })
    );
    expect(reloaded.isEdited).toBeFalsy();
    expect(reloaded.editedAt).toBeUndefined();
    expect(reloaded.restoredUnverified).toBeFalsy();
  });

  it('never replaces a held row that is not marked, whatever proof a copy carries', async () => {
    const { alice, mallory } = await cast();
    const held = { id: 'm1', senderId: 'alice', content: 'held text', timestamp: new Date(1) };
    const ctx = makeCtx(alice, mallory, [held]);
    const authorship = await signedBy(alice, GROUP, HELLO);

    await handleSystemEvent(
      'history_bundle',
      {
        messages: [{ id: 'm1', senderId: 'alice', content: 'x', timestamp: 1, authorship }],
      },
      ctx as any
    );

    expect(ctx.conversations.get(GROUP).messages[0].content).toBe('held text');
    expect(ctx.storage.updateMessage).not.toHaveBeenCalled();
  });

  it('takes the copy whose proof verifies when one bundle carries an id twice, in either order', async () => {
    const { alice, mallory } = await cast();
    const authorship = await signedBy(alice, GROUP, HELLO);
    const unsigned = { id: 'm1', senderId: 'alice', content: 'unsigned', timestamp: 1 };
    const signed = { id: 'm1', senderId: 'alice', content: 'x', timestamp: 1, authorship };

    for (const messages of [
      [unsigned, signed],
      [signed, unsigned],
    ]) {
      const ctx = makeCtx(alice, mallory);
      await handleSystemEvent('history_bundle', { messages }, ctx as any);
      expect(added(ctx)).toEqual([
        expect.objectContaining({ messageId: 'm1', content: helloContent, authorship }),
      ]);
      expect(added(ctx)[0].restoredUnverified).toBeUndefined();
    }
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
