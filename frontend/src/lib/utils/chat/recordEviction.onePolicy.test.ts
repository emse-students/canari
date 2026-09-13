/**
 * ONE DISPOSITION FOR A LEARNT EVICTION, DRIVEN FROM THE SITES RATHER THAN FROM THE FUNCTION.
 *
 * `recordEviction` is trivially testable on its own, and a spec that only did that would pass on
 * exactly the defect this fusion exists to remove: a site that keeps its own idea of what an
 * eviction costs never reaches the shared function, so no test of the shared function can see it.
 * That is not hypothetical here - it is what the five sites actually did. Two retired the row and
 * posted no notice, one posted a notice and retired nothing at all, and the outbox raised a banner
 * on a hook it shared with a group DELETION.
 *
 * So every case below enters through a SITE - the real exported entry point - and asserts the three
 * things a learnt eviction owes, whichever site learnt it:
 *
 *   1. the row is retired, and DURABLY: `lifecycle: 'removed'` is what the send gate, the roster
 *      loader, the frame buffer, the re-add guards and the banner all read, and a retire nobody
 *      persists is undone by the next load;
 *   2. the user is told once, in the thread, rather than left with a conversation that silently
 *      refuses to send;
 *   3. one line names the EVIDENCE, because two of the six mean the fact was learnt by failing.
 */
import type { Conversation } from '$lib/types';
import type { EvictionEvidence } from './eviction';

// ---------------------------------------------------------------- module stubs
// The union of what the five sites need to load at all. Every one of them spreads the real module
// and overrides only what would reach the network, a worker or the user store.
vi.mock('$lib/utils/users/displayName', () => ({
  resolveDisplayNames: vi.fn(async () => (id: string) => id),
  getUserDisplayNameSync: vi.fn((id: string) => `Name(${id})`),
}));

vi.mock('$lib/crypto/ChannelKeyVault', () => ({
  channelKeyManager: {
    getVault: vi.fn(() => ({ rotateKey: vi.fn().mockResolvedValue(undefined) })),
    decryptMessage: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
  },
}));

vi.mock('$lib/services/ChannelService', () => ({
  ChannelService: class MockChannelService {
    markKeyDistributionReceived = vi.fn().mockResolvedValue(undefined);
    ackKeyDistribution = vi.fn().mockResolvedValue(undefined);
    getChannelKeyBootstrap = vi.fn();
    sendMessage = vi.fn().mockResolvedValue(undefined);
  },
}));

const recoveryStub = vi.hoisted(() => ({
  requestReAdd: vi.fn().mockResolvedValue(undefined),
  cancelReAdd: vi.fn(),
}));
vi.mock('$lib/utils/chat/recovery', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/chat/recovery')>()),
  ...recoveryStub,
}));

const groupActionsStub = vi.hoisted(() => ({
  fetchUniqueGroupMembers: vi.fn(),
  isGroupActiveOnServer: vi.fn(async () => true),
}));
vi.mock('$lib/utils/chat/groupActions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/chat/groupActions')>()),
  ...groupActionsStub,
}));

// Encryption is leader-only, so the outbox flushes here as a leader.
vi.mock('$lib/mls-client/tabLeader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/mls-client/tabLeader')>()),
  getIsTabLeader: () => true,
  getTabLeadership: () => 'leader' as const,
  whenTabLeadershipDecided: () => Promise.resolve('leader' as const),
}));
vi.mock('$lib/mls-client/tabMessageSync', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/mls-client/tabMessageSync')>()),
  requestLeaderOutboxFlush: vi.fn(),
  publishOutboxEntrySent: vi.fn(),
  publishOutboxEntryCancelled: vi.fn(),
  subscribeTabOutboxEvents: vi.fn(() => () => {}),
}));

// `useConversations` is reachable from the global chat singleton's own module-scope instantiation,
// so importing it directly would close a cycle.
vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  globalSession: {},
  globalConvs: {},
  globalMessaging: {},
  globalChannels: {},
  globalNotifs: {},
  appendLog: vi.fn(),
}));

import { SvelteMap } from 'svelte/reactivity';
import { recordEviction } from './eviction';
import { setupMessageHandler } from '$lib/mls-client/messagePipeline/setupMessageHandler';
import { handleSystemEvent } from '$lib/mls-client/messagePipeline/systemMessageHandler';
import { createOutbox, type OutboxDeps } from './outbox';
import { createMlsServiceStub } from '$lib/mls-client/test/fixtures/mlsServiceStub';
import { NotAGroupMemberError } from '$lib/mls-client/mlsDeliveryApi';
import type { OutboxEntry } from '$lib/db';

const { useConversations } = await import('$lib/composables/useConversations.svelte');

const GROUP = '11111111-1111-4111-8111-111111111111';

/** What a site did, in the only four terms every site can be asked about. */
interface SiteRun {
  /** The conversation row, after the site ran. */
  row: Conversation | undefined;
  /** Conversation keys whose row reached storage during the run. */
  saved: string[];
  /** System messages posted into the thread, as `content` strings. */
  notices: string[];
  /** Everything written to the session log. */
  lines: string[];
}

function liveConversation(key: string): Conversation {
  return {
    id: GROUP,
    name: key,
    contactName: key,
    lifecycle: 'active',
    conversationType: 'group',
    messages: [],
  } as unknown as Conversation;
}

/**
 * The recorders every site writes into, so the four assertions read the same everywhere.
 *
 * `addMessageToChat` APPENDS TO THE ROW, because the real one does and the disposition dedupes the
 * notice on the thread's own contents. A recorder that only counted calls would let the same
 * removal, learnt twice, post the notice twice and still pass.
 *
 * `saveConversation` accepts both shapes it is handed: the disposition passes a KEY, and the
 * composable's own persister passes the stored record it built from that key.
 */
function recorders(conversations?: Map<string, Conversation>) {
  const saved: string[] = [];
  const notices: string[] = [];
  const lines: string[] = [];
  return {
    saved,
    notices,
    lines,
    log: (msg: string) => void lines.push(msg),
    saveConversation: vi.fn(
      async (target: string | { id?: string }) =>
        void saved.push(typeof target === 'string' ? target : (target.id ?? ''))
    ),
    addMessageToChat: vi.fn(async (_sender: string, content: string, key: string) => {
      notices.push(content);
      const row = conversations?.get(key);
      if (row) {
        conversations!.set(key, {
          ...row,
          messages: [...row.messages, { isSystem: true, content } as never],
        });
      }
    }),
  };
}

/** The one line a site writes when it records an eviction - healthy shape or miss shape. */
function evictionLines(lines: string[]): string[] {
  return lines.filter(
    (l) => l.startsWith('[EVICT] Removed from') || l.includes('learnt its removal by FAILING')
  );
}

// ---------------------------------------------------------------- the sites

/** Deps for one run of the inbound message pipeline, holding `GROUP` as a live conversation. */
function pipelineWorld(over: Record<string, unknown> = {}) {
  const conversations = new SvelteMap<string, Conversation>([[GROUP, liveConversation(GROUP)]]);
  const r = recorders(conversations);
  const mls = createMlsServiceStub({
    getUserGroups: vi.fn().mockResolvedValue([{ groupId: GROUP, name: 'T', isGroup: true }]),
    getLocalGroups: vi.fn().mockReturnValue([GROUP]),
    // The Remove commit merged: OpenMLS is the authority and it says this device is out.
    isGroupActive: vi.fn().mockResolvedValue(false),
    ...over,
  });
  const deps = {
    mlsService: mls,
    storage: null,
    userId: 'me',
    deviceKeyB64: 'device-key',
    historyBaseUrl: 'https://hist',
    conversations,
    messageReactions: new SvelteMap(),
    recoveryTimers: new Map(),
    getSelectedContact: () => null,
    setSelectedContact: vi.fn(),
    saveConversation: r.saveConversation,
    addMessageToChat: r.addMessageToChat,
    loadHistoryForConversation: vi.fn().mockResolvedValue(undefined),
    log: r.log,
  };
  setupMessageHandler(deps as never);
  const onMessage = (mls as never as { onMessage: { mock: { calls: unknown[][] } } }).onMessage.mock
    .calls[0][0] as (
    sender: string,
    content: Uint8Array,
    groupId: string,
    isChannel: boolean,
    meta: unknown,
    isCommit: boolean
  ) => Promise<boolean>;
  return { r, conversations, onMessage };
}

function pipelineResult(
  r: ReturnType<typeof recorders>,
  conversations: SvelteMap<string, Conversation>
): SiteRun {
  return { row: conversations.get(GROUP), saved: r.saved, notices: r.notices, lines: r.lines };
}

/** One text entry queued for `GROUP`, and the storage that holds it. */
function outboxStorage() {
  const map = new Map<string, OutboxEntry>();
  map.set('m1', {
    id: 'm1',
    conversationId: GROUP,
    sentAt: 100,
    kind: 'text',
    text: 'hello',
    status: 'pending',
    attempts: 0,
    createdAt: 100,
  });
  return {
    saveMessage: vi.fn().mockResolvedValue(undefined),
    saveOutboxEntry: vi.fn().mockResolvedValue(undefined),
    getOutboxEntries: vi.fn(async () => [...map.values()]),
    getOutboxEntriesForConversation: vi.fn(async () => [...map.values()]),
    updateOutboxEntry: vi.fn().mockResolvedValue(undefined),
    deleteOutboxEntry: vi.fn(async (id: string) => void map.delete(id)),
  } as never;
}

async function runOutbox(opts: { active: boolean; send?: () => Promise<void> }): Promise<SiteRun> {
  const conversations = new SvelteMap<string, Conversation>([[GROUP, liveConversation(GROUP)]]);
  const r = recorders(conversations);
  const mlsService = {
    getLocalGroups: vi.fn(() => [GROUP]),
    getGroupMeta: vi.fn(async () => ({ groupId: GROUP, name: '', isGroup: true, deletedAt: null })),
    isGroupActive: vi.fn(async () => opts.active),
    sendMessage: vi.fn(opts.send ?? (async () => {})),
    waitForMessageQueueIdle: vi.fn(async () => {}),
  } as never;
  const outbox = createOutbox({
    mlsService,
    storage: outboxStorage(),
    userId: 'me',
    deviceKeyB64: 'device-key',
    conversations,
    log: r.log,
    requestReAdd: vi.fn().mockResolvedValue(undefined),
    recoverRosterDisagreement: vi.fn().mockResolvedValue(undefined),
    isGroupHealthy: () => true,
    markDeletedRemotely: vi.fn(),
    addMessageToChat: r.addMessageToChat,
    saveConversation: r.saveConversation,
  } as OutboxDeps);

  await outbox.flush();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  return { row: conversations.get(GROUP), saved: r.saved, notices: r.notices, lines: r.lines };
}

/** The selection check, entered through the composable that owns it. */
async function runSelectionCheck(opts: {
  local: () => Promise<boolean>;
  members?: () => Promise<string[]>;
}): Promise<SiteRun> {
  const convs = useConversations();
  convs.conversations.set(GROUP, liveConversation(GROUP));
  const r = recorders(convs.conversations);
  groupActionsStub.fetchUniqueGroupMembers.mockImplementation(
    opts.members ??
      (() => {
        throw new NotAGroupMemberError('not a member');
      })
  );
  const ctx = {
    storage: { saveConversation: r.saveConversation } as never,
    ensureMls: () => ({ isGroupActive: vi.fn(opts.local) }) as never,
    userId: 'me',
    deviceKeyB64: 'k',
    historyBaseUrl: 'https://hist',
    messageReactions: new SvelteMap(),
    log: r.log,
    addMessageToChat: r.addMessageToChat,
  } as never;

  await convs.verifyCurrentUserMembership(GROUP, ctx);
  return {
    row: convs.conversations.get(GROUP),
    saved: r.saved,
    notices: r.notices,
    lines: r.lines,
  };
}

/**
 * THE SITES. Five of them, six evidences, and each `run` is the real entry point a caller reaches -
 * never a call to `recordEviction`.
 *
 * The selection check appears twice because it genuinely learns the fact two ways: from the local
 * MLS state, and from the delivery service refusing this device. They are the same site and
 * different evidence, which is exactly the distinction the fused function carries as data.
 */
const sites: { name: string; evidence: EvictionEvidence; run: () => Promise<SiteRun> }[] = [
  {
    name: 'a Remove commit applied',
    evidence: 'remove-commit',
    run: async () => {
      const { r, conversations, onMessage } = pipelineWorld();
      await onMessage('peer', new Uint8Array([9, 9]), GROUP, false, undefined, true);
      return pipelineResult(r, conversations);
    },
  },
  {
    name: 'an inbound frame refused as evicted',
    evidence: 'inbound-frame',
    run: async () => {
      const { r, conversations, onMessage } = pipelineWorld({
        processIncomingMessage: vi.fn(async () => {
          throw new Error('EVICTED: this device holds no leaf');
        }),
      });
      await onMessage('peer', new Uint8Array([9, 9]), GROUP, false, undefined, false);
      return pipelineResult(r, conversations);
    },
  },
  {
    name: 'the exclusion announced by its author',
    evidence: 'system-event',
    run: async () => {
      const conversations = new Map<string, Conversation>([[GROUP, liveConversation(GROUP)]]);
      const r = recorders(conversations);
      await handleSystemEvent('memberRemoved', { targetUser: 'me' }, {
        mlsService: {
          forgetGroup: vi.fn(),
          persistCheckpoint: vi.fn().mockResolvedValue(undefined),
        },
        storage: null,
        userId: 'me',
        deviceKeyB64: 'device-key',
        conversations,
        messageReactions: new Map(),
        addMessageToChat: r.addMessageToChat,
        deleteConversation: vi.fn().mockResolvedValue(undefined),
        saveConversation: r.saveConversation,
        getSelectedContact: () => null,
        setSelectedContact: vi.fn(),
        onReadStateAdvanced: vi.fn(),
        log: r.log,
        convo: conversations.get(GROUP),
        convoKey: GROUP,
        senderNorm: 'admin',
      } as never);
      return { row: conversations.get(GROUP), saved: r.saved, notices: r.notices, lines: r.lines };
    },
  },
  {
    name: 'the outbox reading membership before it sends',
    evidence: 'membership-check',
    run: () => runOutbox({ active: false }),
  },
  {
    name: 'the outbox having its send refused',
    evidence: 'outbound-refusal',
    run: () =>
      runOutbox({
        active: true,
        send: async () => {
          throw new Error('EVICTED: this device holds no leaf');
        },
      }),
  },
  {
    name: 'the selection check, from the delivery service refusing this device',
    evidence: 'server-refusal',
    run: () =>
      runSelectionCheck({
        // `null`, not `false`: the local state cannot say, which is the case the server answers.
        local: async () => {
          throw new Error('Group not found');
        },
      }),
  },
];

describe('every site records a learnt eviction the same way', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    groupActionsStub.isGroupActiveOnServer.mockResolvedValue(true);
  });

  for (const site of sites) {
    describe(site.name, () => {
      it('retires the conversation, and durably', async () => {
        const out = await site.run();

        // The row is the ONLY durable statement of the fact, and everything else reads it.
        expect(out.row?.lifecycle).toBe('removed');
        // A retire nobody persists is undone by the next load, which is what the selection check
        // did for as long as it existed: notice, cache, nothing written.
        expect(out.saved).toContain(GROUP);
      });

      it('tells the user once, in the thread', async () => {
        const out = await site.run();

        expect(out.notices).toHaveLength(1);
        expect(out.notices[0]).toBeTruthy();
      });

      it('names the evidence in one line', async () => {
        const out = await site.run();
        const evict = evictionLines(out.lines);

        expect(evict).toHaveLength(1);
        expect(evict[0]).toContain(GROUP.slice(0, 8));
      });
    });
  }

  // A MISS IS SHAPED DIFFERENTLY ON PURPOSE, and this is what stops a rule written for the healthy
  // path from swallowing it. `[EVICT] Removed from …` is the classified, expected line; a fact
  // learnt by failing must never wear it.
  it('never writes a miss in the shape the healthy path uses', async () => {
    const missed = sites.filter((s) => s.evidence === 'outbound-refusal');
    expect(missed).toHaveLength(1);

    const out = await missed[0].run();
    const evict = evictionLines(out.lines);
    expect(evict[0]).toContain('learnt its removal by FAILING');
    expect(evict[0]).not.toContain('Removed from');
  });

  it('drives six DISTINCT entry points, not one six times', () => {
    expect(new Set(sites.map((s) => s.run.toString())).size).toBe(sites.length);
    expect(new Set(sites.map((s) => s.name)).size).toBe(sites.length);
  });
});

describe('what the disposition itself promises', () => {
  function world(lifecycle: Conversation['lifecycle'] = 'active', messages: unknown[] = []) {
    const conversations = new Map<string, Conversation>([
      [GROUP, { ...liveConversation(GROUP), lifecycle, messages } as Conversation],
    ]);
    return { r: recorders(conversations), conversations };
  }

  it('is idempotent: the same removal learnt twice changes nothing and says so', async () => {
    // Commits are replayed, and the announcement behind a commit is a SECOND evidence for the same
    // removal. Neither may re-write the row or post the notice again.
    const { r, conversations } = world();
    await recordEviction({
      conversations,
      groupId: GROUP,
      evidence: 'remove-commit',
      saveConversation: r.saveConversation,
      addMessageToChat: r.addMessageToChat,
      log: r.log,
    });
    await recordEviction({
      conversations,
      groupId: GROUP,
      evidence: 'system-event',
      saveConversation: r.saveConversation,
      addMessageToChat: r.addMessageToChat,
      log: r.log,
    });

    expect(r.saved).toEqual([GROUP]);
    expect(r.notices).toHaveLength(1);
    expect(r.lines.at(-1)).toContain('already retired, nothing to do');
  });

  it('keeps the wording the campaign classifier pins for a healthy eviction', async () => {
    // `tools/cross-client-harness/watch.mjs` matches this line exactly and counts it as the
    // mechanism WORKING. Renaming it out from under that rule turns every GRP row that evicts a
    // peer into PASS-DIRTY on the sentence proving the defect is gone.
    const { r, conversations } = world();
    await recordEviction({
      conversations,
      groupId: GROUP,
      evidence: 'remove-commit',
      saveConversation: r.saveConversation,
      log: r.log,
    });

    expect(r.lines).toContain(
      `[EVICT] Removed from ${GROUP.slice(0, 8)}… by a Remove commit - conversation retired`
    );
  });

  it('records nothing for a group no conversation carries, and is not silent about it', async () => {
    const r = recorders();
    const out = await recordEviction({
      conversations: new Map(),
      groupId: GROUP,
      evidence: 'inbound-frame',
      saveConversation: r.saveConversation,
      addMessageToChat: r.addMessageToChat,
      log: r.log,
    });

    expect(out).toBe(false);
    expect(r.saved).toEqual([]);
    expect(r.notices).toEqual([]);
    expect(r.lines.join(' ')).toContain('no conversation row carries this group');
  });

  it('still retires when the notice cannot be posted', async () => {
    // The banner is the durable half. A message write that fails must not take the row with it,
    // and it must not be silent either.
    const { r, conversations } = world();
    await recordEviction({
      conversations,
      groupId: GROUP,
      evidence: 'membership-check',
      saveConversation: r.saveConversation,
      addMessageToChat: vi.fn(async () => {
        throw new Error('thread not loaded');
      }),
      log: r.log,
    });

    expect(conversations.get(GROUP)?.lifecycle).toBe('removed');
    expect(r.lines.join(' ')).toContain('removal notice not posted');
  });
});
