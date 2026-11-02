import { handleSystemEvent } from './systemMessageHandler';
import { digestIdentity } from '$lib/utils/chat/historyDigestRendezvous';
import {
  forgetHistoryAsks,
  mintHistoryRequestId,
  noteHistoryAsk,
} from '$lib/utils/chat/historyAddressing';
import { historyStateKey } from '$lib/utils/chat/historyStateKey';
import { m } from '$lib/paraglide/messages';

/**
 * A `history_bundle` reaches the rows memory does not show, and carries a deletion onto a row this
 * device holds even when it is the addressed answer to an ask (2026-11-02, the follow-up of the
 * owner's deleted-message report).
 *
 * The relayer is the AUTHOR throughout, which is what lets a bundle mutate a row without a
 * signature (`relayerVouches`, `bundleVetting.ts`) - the signed path is pinned by
 * `systemMessageHandler.bundleAuthorship.test.ts`.
 */
const ME = 'me';
const MY_DEVICE = 'device-me';
const GROUP = 'g1';
const AUTHOR = 'alice';

function makeCtx(senderNorm: string, rows: Record<string, any>, shown: any[] = []) {
  const conversations = new Map<string, any>();
  conversations.set(GROUP, { id: GROUP, unreadCount: 0, messages: shown });
  const store = new Map<string, any>(Object.entries(rows));
  const storage = {
    getMessagesByIds: vi.fn(async (_c: string, ids: string[]) => ({
      rows: new Map(ids.filter((id) => store.has(id)).map((id) => [id, { ...store.get(id) }])),
      unreadable: new Set<string>(),
    })),
    mergeMessages: vi.fn(async (_c: string, ids: string[], merge: (row: any) => any) => {
      const written = new Set<string>();
      for (const id of ids) {
        const row = store.get(id);
        const next = row ? merge({ ...row }) : null;
        if (next) {
          store.set(id, next);
          written.add(id);
        }
      }
      return written;
    }),
    getPendingMutations: vi.fn(async () => ({ entries: [], removedUnreadable: 0 })),
    updateMessage: vi.fn(async (id: string, patch: any) => {
      const row = store.get(id);
      if (!row) return;
      const next = { ...row };
      for (const [k, v] of Object.entries(patch)) if (v !== undefined) next[k] = v;
      store.set(id, next);
    }),
  };
  const ctx = {
    mlsService: {
      getDeviceId: () => MY_DEVICE,
      getGroupWithheld: vi.fn().mockResolvedValue(new Map([[ME, []]])),
    },
    storage,
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
    senderNorm,
    persistMlsStateNow: vi.fn(),
  };
  return { ctx, store };
}

const STORED = {
  id: 'm1',
  conversationId: GROUP,
  senderId: AUTHOR,
  content: 'hello',
  timestamp: 1000,
};
/** The author's own copy of `m1`, deleted, as `serializeForBundle` relays a tombstone. */
const TOMBSTONE = {
  id: 'm1',
  senderId: AUTHOR,
  content: 'deleted',
  timestamp: 1000,
  isDeleted: true,
};

beforeEach(() => {
  forgetHistoryAsks();
});

describe('history_bundle - rows memory does not show', () => {
  it('tombstones a STORED row the bundle names, and never adds it again', async () => {
    const { ctx, store } = makeCtx(AUTHOR, { m1: STORED });

    await handleSystemEvent('history_bundle', { messages: [TOMBSTONE] }, ctx as any);

    expect(store.get('m1')).toMatchObject({ isDeleted: true, authorship: null });
    expect(store.get('m1').content).toBe(m.chat_system_message_deleted());
    expect(ctx.batchAddMessages).not.toHaveBeenCalled();
  });

  it('takes nothing onto a stored row from a relayer that is not its author', async () => {
    const { ctx, store } = makeCtx('mallory', { m1: STORED });

    await handleSystemEvent('history_bundle', { messages: [TOMBSTONE] }, ctx as any);

    expect(store.get('m1')).toEqual(STORED);
  });
});

describe('history_bundle - an addressed answer carries a deletion onto a held row', () => {
  /** An answer to the digest this device asked, as the reconciliation exchange delivers it. */
  async function answer(ctx: any, messages: unknown[]) {
    const requestId = mintHistoryRequestId();
    noteHistoryAsk(GROUP, requestId, { kind: 'digest', since: 0, askedAt: 1_000_000 });
    await handleSystemEvent(
      'history_bundle',
      { messages, requestId, to: digestIdentity(ME, MY_DEVICE), last: true },
      { ...ctx, deliveryMeta: { addressed: true, senderDeviceId: 'device-alice' } }
    );
  }

  it('applies it - shown and stored - so the two state keys agree and the exchange stops', async () => {
    const shownRow = { id: 'm1', senderId: AUTHOR, content: 'hello', timestamp: new Date(1000) };
    const { ctx, store } = makeCtx(AUTHOR, { m1: STORED }, [shownRow]);
    const answerer = [{ ...STORED, isDeleted: true, content: 'deleted' }];
    expect(await historyStateKey([store.get('m1')])).not.toBe(await historyStateKey(answerer));

    await answer(ctx, [TOMBSTONE]);

    expect(ctx.conversations.get(GROUP).messages[0].isDeleted).toBe(true);
    expect(store.get('m1').isDeleted).toBe(true);
    expect(await historyStateKey([store.get('m1')])).toBe(await historyStateKey(answerer));
  });

  it('still refuses it from a relayer that is not the author', async () => {
    const { ctx, store } = makeCtx('mallory', { m1: STORED });

    await answer(ctx, [TOMBSTONE]);

    expect(store.get('m1').isDeleted).toBeUndefined();
  });

  it('changes nothing else on a held row - an addressed answer still only adds', async () => {
    const { ctx, store } = makeCtx(AUTHOR, { m1: STORED });

    await answer(ctx, [{ ...STORED, content: 'edited', isEdited: true, editedAt: 5000 }]);

    expect(store.get('m1')).toEqual(STORED);
  });
});
