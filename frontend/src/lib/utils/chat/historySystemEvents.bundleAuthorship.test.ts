import { afterEach, describe, expect, it, vi } from 'vitest';
import { canari } from '$lib/proto/canari.js';
import type { ChatMessage, Conversation, MessageReaction, ReadWatermarks } from '$lib/types';
import type { StoredMessagePatch } from '$lib/db/types';
import { applyReplaySystemEvent, type PendingHistoryMessage } from './historySystemEvents';
import { keySource, newTestAuthor, signedBy } from '$lib/crypto/messageAuthorship.testKit';
import type { RecordedAuthorship } from '$lib/crypto/messageAuthorship';
import { mkSystem } from '$lib/proto/codec';
import { mkTextEnvelope, serializeEnvelope } from '$lib/envelope';
import {
  recordedIntegrityFindings,
  resetIntegrityFindings,
} from '$lib/mls-client/integrityFindings';

/**
 * A `history_bundle` REPLAYED FROM THE ARCHIVE takes the same rule as one received live
 * (`bundleVetting.ts`): a durable bundle an older build wrote keeps restoring history - marked when
 * nothing proves its author - and nothing in it is taken on its relayer's word about somebody else.
 */

const GROUP = 'g-replay';
const CONVO = 'convo-1';
const SENT_AT = 1_700_000_000_000;
const HELLO = { messageId: 'm1', sentAt: SENT_AT, text: { content: 'hello' } };
const helloContent = serializeEnvelope(mkTextEnvelope('hello'));

afterEach(() => resetIntegrityFindings());

async function cast() {
  const alice = await newTestAuthor('alice:dev-a');
  const mallory = await newTestAuthor('mallory:dev-m');
  return { alice, mallory, keys: keySource({ tree: [alice, mallory] }) };
}

function held(extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm1',
    senderId: 'alice',
    content: helloContent,
    timestamp: new Date(SENT_AT),
    isOwn: false,
    ...extra,
  };
}

/** Replays one bundle relayed by `relayer`, returning every sink the replay may have written. */
async function replayBundle(
  keys: ReturnType<typeof keySource>,
  relayer: string,
  messages: Record<string, unknown>[],
  rows: ChatMessage[] = [],
  pending: PendingHistoryMessage[] = []
) {
  let convo = { id: CONVO, name: 't', messages: rows, lifecycle: 'active' } as Conversation;
  const sinks = {
    pushed: [] as Record<string, unknown>[],
    pendingById: new Map(pending.map((p) => [String(p.messageId), p])),
    reactionUpdates: new Map<string, MessageReaction[]>(),
    rowPatches: new Map<string, StoredMessagePatch>(),
    deletedMessages: new Map<string, { by: string; proof?: RecordedAuthorship }>(),
    editedMessages: new Map<
      string,
      { content: string; editedAt: Date; by: string; proof?: RecordedAuthorship }
    >(),
  };
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await applyReplaySystemEvent({
    parsed: canari.AppMessage.fromObject({
      system: { event: 'history_bundle', data: JSON.stringify({ messages }) },
    }),
    msg: { id: '1-0', sender_id: relayer, content: '', timestamp: '2026-10-23T10:00:00.000Z' },
    contactName: CONVO,
    userId: 'me',
    conversationId: GROUP,
    authorKeys: keys,
    getConversation: () => convo,
    setConversation: (_name, next) => {
      convo = next;
    },
    messageReactions: new Map(),
    reactionUpdates: sinks.reactionUpdates,
    rowPatches: sinks.rowPatches,
    pendingById: sinks.pendingById,
    deletedMessages: sinks.deletedMessages,
    editedMessages: sinks.editedMessages,
    readWatermarkUpdates: {} as ReadWatermarks,
    serverReadWatermarkUpdates: {} as ReadWatermarks,
    historyFloorUpdate: { at: 0 },
    pushPendingMessage: (entry) => sinks.pushed.push(entry as Record<string, unknown>),
    dropOwnExcluded: async (m) => m,
  });
  vi.mocked(console.error).mockRestore();
  return { convo: () => convo, ...sinks };
}

describe('a history_bundle replayed from the archive', () => {
  it('restores an unsigned message relayed by another member, MARKED', async () => {
    const { keys } = await cast();
    const { pushed } = await replayBundle(keys, 'mallory', [
      { id: 'm1', senderId: 'alice', content: helloContent, timestamp: SENT_AT },
    ]);
    expect(pushed).toEqual([
      expect.objectContaining({ messageId: 'm1', senderId: 'alice', restoredUnverified: true }),
    ]);
  });

  it('takes a signed message from the signed bytes, unmarked, and keeps its proof', async () => {
    const { alice, keys } = await cast();
    const authorship = await signedBy(alice, GROUP, HELLO);
    const { pushed } = await replayBundle(keys, 'mallory', [
      { id: 'm1', senderId: 'alice', content: 'words alice never wrote', timestamp: 1, authorship },
    ]);
    expect(pushed).toEqual([
      expect.objectContaining({ messageId: 'm1', content: helloContent, authorship }),
    ]);
    expect(pushed[0].restoredUnverified).toBeUndefined();
  });

  it('REFUSES a message whose proof is malformed, and records the finding', async () => {
    const { alice, keys } = await cast();
    const signed = await signedBy(alice, GROUP, HELLO);
    const { pushed } = await replayBundle(keys, 'mallory', [
      {
        id: 'm1',
        senderId: 'alice',
        content: helloContent,
        timestamp: SENT_AT,
        authorship: { ...signed, proof: 'AAAA' },
      },
    ]);
    expect(pushed).toEqual([]);
    expect(recordedIntegrityFindings()).toEqual([
      expect.objectContaining({ kind: 'forged-history', peer: 'mallory', detail: 'message' }),
    ]);
  });

  it('keeps the mark on a row its relayer holds only as unverified', async () => {
    const { keys } = await cast();
    const { pushed } = await replayBundle(keys, 'alice', [
      {
        id: 'm1',
        senderId: 'alice',
        content: helloContent,
        timestamp: SENT_AT,
        authorUnproven: true,
      },
    ]);
    expect(pushed).toEqual([expect.objectContaining({ restoredUnverified: true })]);
  });

  it("never applies a relayer's tombstone of somebody else's held message without its proof", async () => {
    const { keys } = await cast();
    const { convo, rowPatches } = await replayBundle(
      keys,
      'mallory',
      [{ id: 'm1', senderId: 'alice', content: 'x', timestamp: SENT_AT, isDeleted: true }],
      [held()]
    );
    expect(convo().messages[0].isDeleted).toBeUndefined();
    expect(convo().messages[0].content).toBe(helloContent);
    expect(rowPatches.size).toBe(0);
  });

  it("never applies a relayer's tombstone on a NEW message of somebody else without its proof", async () => {
    const { keys } = await cast();
    const { pushed } = await replayBundle(keys, 'mallory', [
      { id: 'm1', senderId: 'alice', content: helloContent, timestamp: SENT_AT, isDeleted: true },
    ]);
    expect(pushed[0].isDeleted).toBeUndefined();
  });

  it('applies a tombstone the author signed, whoever relays it', async () => {
    const { alice, keys } = await cast();
    const deleteProof = await signedBy(
      alice,
      GROUP,
      mkSystem('delete_message', JSON.stringify({ messageId: 'm1' }))
    );
    const { convo, rowPatches } = await replayBundle(
      keys,
      'mallory',
      [
        {
          id: 'm1',
          senderId: 'alice',
          content: 'x',
          timestamp: SENT_AT,
          isDeleted: true,
          deleteProof,
        },
      ],
      [held()]
    );
    expect(convo().messages[0].isDeleted).toBe(true);
    expect(rowPatches.get('m1')).toEqual(
      expect.objectContaining({ isDeleted: true, deleteProof, authorship: null, editProof: null })
    );
  });

  it("never applies a relayer's edit of somebody else's held message without its proof", async () => {
    const { keys } = await cast();
    const { convo, rowPatches } = await replayBundle(
      keys,
      'mallory',
      [
        {
          id: 'm1',
          senderId: 'alice',
          content: serializeEnvelope(mkTextEnvelope('words alice never wrote')),
          timestamp: SENT_AT,
          isEdited: true,
          editedAt: 9000,
        },
      ],
      [held()]
    );
    expect(convo().messages[0].content).toBe(helloContent);
    expect(convo().messages[0].isEdited).toBeFalsy();
    expect(rowPatches.size).toBe(0);
  });

  it('applies an edit the author signed, whoever relays it', async () => {
    const { alice, keys } = await cast();
    const editProof = await signedBy(
      alice,
      GROUP,
      mkSystem(
        'edit_message',
        JSON.stringify({ messageId: 'm1', newContent: 'fixed', editedAt: 9000 })
      )
    );
    const { convo, rowPatches } = await replayBundle(
      keys,
      'mallory',
      [
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
      [held()]
    );
    const fixed = serializeEnvelope(mkTextEnvelope('fixed'));
    expect(convo().messages[0].content).toBe(fixed);
    expect(rowPatches.get('m1')).toEqual(
      expect.objectContaining({ content: fixed, editProof, isEdited: true, editedAt: 9000 })
    );
  });

  it("drops reactions put in somebody else's name without that member's signature", async () => {
    const { keys } = await cast();
    const { reactionUpdates } = await replayBundle(
      keys,
      'mallory',
      [
        {
          id: 'm1',
          senderId: 'alice',
          content: helloContent,
          timestamp: SENT_AT,
          reactions: [
            { userId: 'alice', emoji: 'x', at: 5 },
            { userId: 'mallory', emoji: 'y', at: 6 },
          ],
        },
      ],
      [held()]
    );
    expect(reactionUpdates.get('m1')?.map((r) => r.emoji)).toEqual(['y']);
  });

  it('an upgrade replaces the unverified row ENTIRELY - the sender comes from the proof', async () => {
    const { alice, keys } = await cast();
    const authorship = await signedBy(alice, GROUP, HELLO);
    const { convo, rowPatches } = await replayBundle(
      keys,
      'mallory',
      [{ id: 'm1', senderId: 'alice', content: 'x', timestamp: 1, authorship }],
      [
        held({
          senderId: 'mallory',
          content: 'words nobody signed',
          restoredUnverified: true,
          isEdited: true,
          editedAt: new Date(5),
        }),
      ]
    );
    const row = convo().messages[0];
    expect(row.senderId).toBe('alice');
    expect(row.isEdited).toBeFalsy();
    expect(row.editedAt).toBeUndefined();
    expect(rowPatches.get('m1')).toEqual(
      expect.objectContaining({
        senderId: 'alice',
        content: helloContent,
        isEdited: false,
        editedAt: null,
        editProof: null,
        restoredUnverified: false,
      })
    );
  });

  it('never queues a second row for an id this page already queued - a proven one is never downgraded', async () => {
    const { alice, keys } = await cast();
    const authorship = await signedBy(alice, GROUP, HELLO);
    const queued: PendingHistoryMessage = {
      senderId: 'alice',
      content: helloContent,
      messageId: 'm1',
      authorship,
      ingestSequence: 0,
    };
    const { pushed, pendingById } = await replayBundle(
      keys,
      'mallory',
      [{ id: 'm1', senderId: 'alice', content: 'relayed words', timestamp: SENT_AT }],
      [],
      [queued]
    );
    expect(pushed).toEqual([]);
    const row = pendingById.get('m1')!;
    expect(row.content).toBe(helloContent);
    expect(row.authorship).toEqual(authorship);
    expect(row.restoredUnverified).toBeUndefined();
  });

  it('upgrades a row this page queued unverified when a proven copy follows', async () => {
    const { alice, keys } = await cast();
    const authorship = await signedBy(alice, GROUP, HELLO);
    const queued: PendingHistoryMessage = {
      senderId: 'mallory',
      content: 'relayed words',
      messageId: 'm1',
      restoredUnverified: true,
      ingestSequence: 0,
    };
    const { pushed, pendingById } = await replayBundle(
      keys,
      'mallory',
      [{ id: 'm1', senderId: 'alice', content: 'x', timestamp: 1, authorship }],
      [],
      [queued]
    );
    expect(pushed).toEqual([]);
    const row = pendingById.get('m1')!;
    expect(row.senderId).toBe('alice');
    expect(row.content).toBe(helloContent);
    expect(row.authorship).toEqual(authorship);
    expect(row.restoredUnverified).toBeFalsy();
  });

  it('a row both in memory and queued takes the signed tombstone in memory too', async () => {
    const { alice, keys } = await cast();
    const deleteProof = await signedBy(
      alice,
      GROUP,
      mkSystem('delete_message', JSON.stringify({ messageId: 'm1' }))
    );
    const queued: PendingHistoryMessage = {
      senderId: 'alice',
      content: 'relayed words',
      messageId: 'm1',
      restoredUnverified: true,
      ingestSequence: 0,
    };
    const { convo, pendingById, rowPatches } = await replayBundle(
      keys,
      'mallory',
      [
        {
          id: 'm1',
          senderId: 'alice',
          content: 'x',
          timestamp: SENT_AT,
          isDeleted: true,
          deleteProof,
        },
      ],
      [held()],
      [queued]
    );
    expect(pendingById.get('m1')?.isDeleted).toBe(true);
    expect(pendingById.get('m1')?.deleteProof).toEqual(deleteProof);
    expect(convo().messages[0].isDeleted).toBe(true);
    // The queued row's write reaches storage; no second write is patched over it.
    expect(rowPatches.size).toBe(0);
  });

  it("a row both in memory and queued takes the signed edit's TEXT onto memory's own body", async () => {
    const { alice, keys } = await cast();
    const editProof = await signedBy(
      alice,
      GROUP,
      mkSystem(
        'edit_message',
        JSON.stringify({ messageId: 'm1', newContent: 'fixed', editedAt: 9000 })
      )
    );
    // Memory's body quotes one message, the relayed copy another: the quote is the body's, and only
    // the signed text moves.
    const ownQuote = { id: 'q-own', senderId: 'bob', content: 'quoted' };
    const memoryBody = serializeEnvelope({ kind: 'text', text: 'hello', replyTo: ownQuote });
    const queued: PendingHistoryMessage = {
      senderId: 'alice',
      content: serializeEnvelope({
        kind: 'text',
        text: 'relayed words',
        replyTo: { id: 'q-relayed', senderId: 'mallory', content: 'other' },
      }),
      messageId: 'm1',
      restoredUnverified: true,
      ingestSequence: 0,
    };
    const { convo } = await replayBundle(
      keys,
      'mallory',
      [
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
      [held({ content: memoryBody })],
      [queued]
    );
    const row = convo().messages[0];
    expect(row.content).toBe(serializeEnvelope({ kind: 'text', text: 'fixed', replyTo: ownQuote }));
    expect(row.isEdited).toBe(true);
  });

  it('a row both in memory and queued, MARKED in both, is upgraded in memory too', async () => {
    const { alice, keys } = await cast();
    const authorship = await signedBy(alice, GROUP, HELLO);
    const queued: PendingHistoryMessage = {
      senderId: 'mallory',
      content: 'relayed words',
      messageId: 'm1',
      restoredUnverified: true,
      ingestSequence: 0,
    };
    const { convo, rowPatches } = await replayBundle(
      keys,
      'mallory',
      [{ id: 'm1', senderId: 'alice', content: 'x', timestamp: 1, authorship }],
      [held({ senderId: 'mallory', content: 'relayed words', restoredUnverified: true })],
      [queued]
    );
    const row = convo().messages[0];
    expect(row.senderId).toBe('alice');
    expect(row.content).toBe(helloContent);
    expect(row.restoredUnverified).toBeFalsy();
    expect(rowPatches.size).toBe(0);
  });

  it('upgrades a held MARKED row from a copy whose proof verifies, and clears the mark', async () => {
    const { alice, keys } = await cast();
    const authorship = await signedBy(alice, GROUP, HELLO);
    const { convo, rowPatches } = await replayBundle(
      keys,
      'mallory',
      [{ id: 'm1', senderId: 'alice', content: 'x', timestamp: 1, authorship }],
      [held({ content: 'unproven words', timestamp: new Date(1), restoredUnverified: true })]
    );
    expect(convo().messages[0].content).toBe(helloContent);
    expect(convo().messages[0].restoredUnverified).toBeFalsy();
    expect(rowPatches.get('m1')).toEqual(
      expect.objectContaining({
        content: helloContent,
        timestamp: SENT_AT,
        authorship,
        restoredUnverified: false,
      })
    );
  });
});
