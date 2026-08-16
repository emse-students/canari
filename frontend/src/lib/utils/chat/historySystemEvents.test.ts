import { canari } from '$lib/proto/canari.js';
import type { ChatMessage, Conversation, MessageReaction, ReadWatermarks } from '$lib/types';
import { applyReplaySystemEvent, type HistoryRow } from './historySystemEvents';
import { pinnedMessageIds } from '$lib/stores/pinStore.svelte';

/**
 * The replay handlers for mutations, exercised for the first time.
 *
 * They were unreachable for MLS groups until 2026-08-12: no mutation ever entered the shared log,
 * so nothing replayed one. The durability split made them the path EVERY mutation takes on replay,
 * which is why the spec's D7 turned from "delete this dead code" into "verify it" - and why this
 * file exists at all, the module having had no test until now.
 */

const OWNER = 'user-a';
const OTHER = 'user-b';
const CONVO = 'g1';
/** The GROUP id, which pin state is keyed by - deliberately not the conversation map key. */
const GROUP = 'group-1';

function message(id: string, senderId: string, content = 'hello'): ChatMessage {
  return {
    id,
    senderId,
    content,
    timestamp: new Date(1_700_000_000_000),
    isOwn: senderId === OWNER,
  };
}

function conversation(messages: ChatMessage[]): Conversation {
  return {
    id: CONVO,
    name: 'test',
    contactName: 'test',
    messages,
    lifecycle: 'active',
  } as Conversation;
}

function systemEvent(event: string, data: Record<string, unknown>): canari.AppMessage {
  return canari.AppMessage.fromObject({
    system: { event, data: JSON.stringify(data) },
  });
}

function row(senderId: string): HistoryRow {
  return { id: '1-0', sender_id: senderId, content: '', timestamp: '2026-08-12T10:00:00.000Z' };
}

/** Drives one replay event against a conversation, returning every sink it may have written. */
async function replay(
  parsed: canari.AppMessage,
  sender: string,
  messages: ChatMessage[],
  // The pin store caches one set per conversation for the life of the module, so a test that wants
  // a device with no pin state has to ask under a name no earlier test has written.
  groupId: string = GROUP
): Promise<{
  convo: Conversation;
  deletedMessages: Map<string, { by: string }>;
  editedMessages: Map<string, { content: string; editedAt: Date; by: string }>;
  reactionUpdates: Map<string, MessageReaction[]>;
  readWatermarkUpdates: ReadWatermarks;
  historyFloorUpdate: { at: number };
  pushed: unknown[];
}> {
  let convo = conversation(messages);
  const sinks = {
    deletedMessages: new Map<string, { by: string }>(),
    editedMessages: new Map<string, { content: string; editedAt: Date; by: string }>(),
    reactionUpdates: new Map<string, MessageReaction[]>(),
    readWatermarkUpdates: {} as ReadWatermarks,
    historyFloorUpdate: { at: 0 },
    pushed: [] as unknown[],
  };
  await applyReplaySystemEvent({
    parsed,
    msg: row(sender),
    contactName: CONVO,
    userId: OWNER,
    conversationId: groupId,
    getConversation: () => convo,
    setConversation: (_name, next) => {
      convo = next;
    },
    messageReactions: new Map(),
    reactionUpdates: sinks.reactionUpdates,
    deletedMessages: sinks.deletedMessages,
    editedMessages: sinks.editedMessages,
    readWatermarkUpdates: sinks.readWatermarkUpdates,
    historyFloorUpdate: sinks.historyFloorUpdate,
    pushPendingMessage: (entry) => sinks.pushed.push(entry),
  });
  return { convo, ...sinks };
}

describe('replaying a deletion', () => {
  it("applies the author's own deletion", async () => {
    const result = await replay(systemEvent('delete_message', { messageId: 'm1' }), OWNER, [
      message('m1', OWNER),
    ]);

    expect(result.convo.messages[0].isDeleted).toBe(true);
    expect(result.convo.messages[0].content).not.toBe('hello');
    expect(result.deletedMessages.get('m1')).toEqual({ by: OWNER });
  });

  it("refuses somebody else's deletion, and records nothing from it", async () => {
    // The live path has refused this since the mutation-ownership fix. The replay path never did,
    // and the durability split put these frames in the shared log - so a member could have deleted
    // any message in the group on every device that later replayed the log.
    const result = await replay(systemEvent('delete_message', { messageId: 'm1' }), OTHER, [
      message('m1', OWNER),
    ]);

    expect(result.convo.messages[0].isDeleted).toBeUndefined();
    expect(result.convo.messages[0].content).toBe('hello');
    expect(result.deletedMessages.size).toBe(0);
  });

  it('carries the claimed author when the message is not in memory', async () => {
    // Nothing here can check the claim - the row is read after the batch save, and that is where
    // `history.ts` checks it. Recording WHO is what makes that possible.
    const result = await replay(systemEvent('delete_message', { messageId: 'gone' }), OTHER, []);

    expect(result.deletedMessages.get('gone')).toEqual({ by: OTHER });
  });
});

describe('replaying an edit', () => {
  it("applies the author's own edit, with its time", async () => {
    const result = await replay(
      systemEvent('edit_message', {
        messageId: 'm1',
        newContent: 'corrected',
        editedAt: 1_700_000_042_000,
      }),
      OWNER,
      [message('m1', OWNER)]
    );

    expect(result.convo.messages[0]).toMatchObject({ content: 'corrected', isEdited: true });
    expect(result.convo.messages[0].editedAt?.getTime()).toBe(1_700_000_042_000);
    expect(result.editedMessages.get('m1')).toMatchObject({ content: 'corrected', by: OWNER });
  });

  it("refuses somebody else's edit, and records nothing from it", async () => {
    const result = await replay(
      systemEvent('edit_message', { messageId: 'm1', newContent: 'rewritten' }),
      OTHER,
      [message('m1', OWNER)]
    );

    expect(result.convo.messages[0].content).toBe('hello');
    expect(result.convo.messages[0].isEdited).toBeUndefined();
    expect(result.editedMessages.size).toBe(0);
  });
});

describe('replaying read state', () => {
  it('accumulates a watermark for the page rather than touching each message', async () => {
    const result = await replay(systemEvent('read_watermark', { at: 1_700_000_000_000 }), OTHER, [
      message('m1', OWNER),
    ]);

    expect(result.readWatermarkUpdates).toEqual({ [OTHER]: 1_700_000_000_000 });
  });

  it('keeps the furthest of several, whichever order they replay in', async () => {
    // Two frames from the same reader in one page: `max` is what makes the order irrelevant.
    const later = await replay(systemEvent('read_watermark', { at: 2_000 }), OTHER, []);
    const earlier = await replay(systemEvent('read_watermark', { at: 1_000 }), OTHER, []);

    expect(later.readWatermarkUpdates).toEqual({ [OTHER]: 2_000 });
    expect(earlier.readWatermarkUpdates).toEqual({ [OTHER]: 1_000 });
  });

  it('translates a legacy read_receipt into the instant of the messages it names', async () => {
    const result = await replay(systemEvent('read_receipt', { messageIds: ['m1'] }), OTHER, [
      message('m1', OWNER),
    ]);

    expect(result.readWatermarkUpdates).toEqual({ [OTHER]: 1_700_000_000_000 });
  });

  it('takes nothing from a legacy receipt naming messages this device does not hold', async () => {
    const result = await replay(systemEvent('read_receipt', { messageIds: ['gone'] }), OTHER, [
      message('m1', OWNER),
    ]);

    expect(result.readWatermarkUpdates).toEqual({});
  });

  it('takes the read state a bundle carries, even one with no messages', async () => {
    const result = await replay(
      systemEvent('history_bundle', { messages: [], readWatermarks: { [OTHER]: 4_000 } }),
      OTHER,
      [message('m1', OWNER)]
    );

    expect(result.readWatermarkUpdates).toEqual({ [OTHER]: 4_000 });
  });
});

describe('replaying a legacy remove_reaction', () => {
  it('records the withdrawal as an entry, so it can still reach a peer holding the placement', async () => {
    // The old frame shape, kept only to decode log entries written before removals became a
    // `ReactionMsg`. It must land in the same convergent set as everything else.
    const result = await replay(
      systemEvent('remove_reaction', { messageId: 'm1', emoji: '👍' }),
      OTHER,
      [message('m1', OWNER)]
    );

    const updated = result.reactionUpdates.get('m1');
    expect(updated).toHaveLength(1);
    expect(updated![0]).toMatchObject({ emoji: '👍', userId: OTHER, removed: true });
    expect(updated![0].at).toBeGreaterThan(0);
  });
});

describe('events a replay must not act on', () => {
  it('ignores a history digest and a history pull', async () => {
    // Both describe an instant that has passed: a digest diffed against a store that has moved on,
    // a pull answered days ago or never. Named rather than left to fall through, so adding a
    // branch for them later has to be a decision.
    for (const event of ['history_digest', 'history_pull']) {
      const result = await replay(systemEvent(event, { from: OTHER }), OTHER, [
        message('m1', OWNER),
      ]);
      expect(result.pushed).toEqual([]);
      expect(result.convo.messages[0]).toMatchObject({ content: 'hello' });
    }
  });
});

describe('the shared history floor', () => {
  it('takes the floor a bundle carries, whether or not the bundle carries messages', async () => {
    const result = await replay(
      systemEvent('history_bundle', { messages: [], floor: 4000 }),
      OTHER,
      []
    );

    expect(result.historyFloorUpdate.at).toBe(4000);
  });

  it('keeps the larger floor when two bundles disagree, in either order', async () => {
    // The merge is `max`, so the order chunks land in cannot change where the floor ends up.
    for (const order of [
      [4000, 9000],
      [9000, 4000],
    ]) {
      let seen = 0;
      for (const floor of order) {
        const result = await replay(
          systemEvent('history_bundle', { messages: [], floor }),
          OTHER,
          []
        );
        seen = Math.max(seen, result.historyFloorUpdate.at);
      }
      expect(seen).toBe(9000);
    }
  });

  it('ignores a floor that is not a usable instant', async () => {
    const result = await replay(
      systemEvent('history_bundle', { messages: [], floor: 'whenever' }),
      OTHER,
      []
    );

    expect(result.historyFloorUpdate.at).toBe(0);
  });
});

/**
 * MUT-15: a pin did not survive on a fresh device.
 *
 * `pin`/`unpin` fell through this chain unhandled - not ignored on purpose, which the set at the
 * top of the module exists to make an explicit decision, just absent. The events are durable in the
 * shared log and the live path has always applied them; only the replay never did.
 */
describe('replaying a pin', () => {
  it('pins from the log, and unpins from it', async () => {
    const g = 'group-pin-unpin';
    await replay(systemEvent('pin', { messageId: 'm1' }), OTHER, [message('m1', OTHER)], g);
    expect(pinnedMessageIds(g)).toEqual(['m1']);

    await replay(systemEvent('unpin', { messageId: 'm1' }), OTHER, [message('m1', OTHER)], g);
    expect(pinnedMessageIds(g)).toEqual([]);
  });

  it('keys the pin by the GROUP, not by the conversation map key', async () => {
    const g = 'group-pin-key';
    await replay(systemEvent('pin', { messageId: 'm1' }), OTHER, [message('m1', OTHER)], g);

    // Filed under the map key it would be written where no reader looks: every other call site -
    // the toolbar, the live handler, the bundle builder - keys pin state by the group id.
    expect(pinnedMessageIds(CONVO)).toEqual([]);
    expect(pinnedMessageIds(g)).toEqual(['m1']);
  });

  it("adopts a bundle's pinned set on a device that holds none", async () => {
    const g = 'group-pin-seed';
    await replay(systemEvent('history_bundle', { messages: [], pins: ['m1', 'm2'] }), OTHER, [], g);

    // The frame that pinned it may be older than the server's retention window while the pin is
    // not, so replaying the log alone can never be enough on a conversation of any age.
    expect(pinnedMessageIds(g).sort()).toEqual(['m1', 'm2']);
  });

  it('never lets a bundle overwrite pin state this device already has', async () => {
    const g = 'group-pin-noclobber';
    await replay(systemEvent('pin', { messageId: 'm1' }), OTHER, [message('m1', OTHER)], g);
    await replay(systemEvent('unpin', { messageId: 'm1' }), OTHER, [message('m1', OTHER)], g);
    await replay(systemEvent('pin', { messageId: 'm9' }), OTHER, [message('m9', OTHER)], g);

    // A peer that has not seen the unpin answers with its own snapshot. Adopting it would
    // resurrect a pin this device took back, and there is no clock to order the two.
    await replay(systemEvent('history_bundle', { messages: [], pins: ['m1'] }), OTHER, [], g);

    expect(pinnedMessageIds(g)).toEqual(['m9']);
  });
});
