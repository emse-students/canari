// @vitest-environment happy-dom
/**
 * AT A COLD START NOTHING INBOUND IS HANDLED BEFORE THE RESTORE HAS SEEDED THE CONVERSATION ROWS.
 *
 * Measured on the Mi 9T (`1.6.5-alpha.1`, 2026-11-05): the login opened the gateway and pulled the
 * mailbox before the restore wrote a single row, so six frames of three DMs this device already held
 * were refused `absent-conversation` 200 ms before `[RESTORE] 22 conversation row(s) seeded`, left
 * in the server queue, and fetched again by the seeding. Nothing was lost - a race that heals, and
 * still a defect (backlog, "the boot drain handles frames before the restore seeds their rows").
 *
 * The fix is an ORDER, carried by an event: the login arms a hold before the socket can deliver a
 * byte, and the restore's seeding (`notifyConversationRowsSeeded`) releases it - the held socket
 * frames and the boot pull alike. What is asserted is therefore never a duration: it is what the
 * conversation map held at the moment a frame was routed and at the moment the pull was issued,
 * with the REAL restore (`loadExistingConversations`) doing the seeding.
 */
import { SvelteMap } from 'svelte/reactivity';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Conversation } from '$lib/types';
import { BaseMlsService } from '$lib/services/BaseMlsService';
import { resetUnackedFrames } from '$lib/mls-client/messagePipeline/unackedFrames';

vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  globalMessaging: { isMessageCatchupActive: false, resetMessageCatchupState: vi.fn() },
  globalSession: {},
  globalConvs: {},
  globalChannels: {},
  globalNotifs: {},
  appendLog: vi.fn(),
}));

// The reconnect path reaches the pull through `openGatewayConnection`, which fetches a token and
// is a leader-tab path: both stubbed, the rest of each module real.
vi.mock('$lib/stores/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/stores/auth')>()),
  getToken: async () => 'jwt',
}));
vi.mock('$lib/mls-client/tabLeader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/mls-client/tabLeader')>()),
  getIsTabLeader: () => true,
}));

const { openGatewayConnection } = await import('$lib/mls-client/initializeConnection');
const { loadExistingConversations } = await import('$lib/utils/chat/conversations');

/** @see BaseMlsService.inboundGate.test.ts - the cast is what instantiates the abstract base. */
abstract class Harness extends BaseMlsService {
  protected override pausePlatformSocket(): void {}
}

/** The stored conversation of a DM this device holds, as `storage.getConversations` returns it. */
const DM = 'dm-1';

/**
 * A service whose platform half records, for every routed frame and for the pull, whether the DM's
 * row existed at that instant - the one fact the `absent-conversation` refusal reads.
 */
function makeService(conversations: SvelteMap<string, Conversation>) {
  const seen = { routedWithRow: [] as boolean[], pullWithRow: [] as boolean[] };
  const svc = new (Harness as unknown as new (platform: 'web' | 'tauri') => BaseMlsService)('web');
  Object.assign(svc, {
    userId: 'u1',
    isWsOpen: () => true,
    routeFrame: async () => {
      seen.routedWithRow.push(conversations.has(DM));
    },
    messageCallback: vi.fn().mockResolvedValue(true),
    messageScheduler: {
      waitUntilIdle: vi.fn().mockResolvedValue(undefined),
      hasQueuedFrom: () => false,
      draining: false,
    },
    delivery: {
      ackMessages: vi.fn().mockResolvedValue(undefined),
      pullPendingMessagesJson: vi.fn(async () => {
        seen.pullWithRow.push(conversations.has(DM));
      }),
    },
  });
  return { svc, seen };
}

/** A frame as the socket delivers it, reached the way both platform sockets reach the gate. */
const deliver = (svc: BaseMlsService, proto: string) =>
  (
    svc as unknown as { deliverFrame(msg: Record<string, unknown>, t: string): Promise<void> }
  ).deliverFrame({ proto, groupId: DM }, '');

/** The real restore, over a store holding the DM, notifying the real service of its seeding. */
function restore(conversations: SvelteMap<string, Conversation>, svc: BaseMlsService) {
  return loadExistingConversations({
    storage: {
      getConversations: vi.fn(async () => [{ id: DM, name: 'Bob', lifecycle: 'active' }]),
      saveConversation: vi.fn(async () => {}),
      getMessagesPage: vi.fn(async () => []),
      deleteMessagesForConversation: vi.fn(async () => {}),
      getMessages: vi.fn(async () => []),
      deleteConversation: vi.fn(async () => {}),
    },
    mlsService: {
      getLocalGroups: vi.fn(() => []),
      getUserGroups: vi.fn(async () => []),
      notifyConversationsRestored: () => svc.notifyConversationsRestored(),
      notifyConversationRowsSeeded: () => svc.notifyConversationRowsSeeded(),
      beginBulkIngest: vi.fn(),
      endBulkIngest: vi.fn(),
      persistCheckpoint: vi.fn(async () => {}),
      isDistributionGroup: vi.fn(() => false),
      getDismissedGroups: vi.fn(async () => []),
    },
    conversations,
    messageReactions: new SvelteMap(),
    userId: 'u1',
    deviceKeyB64: 'k',
    archivedConversationIds: [],
    historyBaseUrl: '',
    onArchivedIdsChange: vi.fn(),
    log: vi.fn(),
  } as never);
}

/** Lets every pending continuation run, so "not yet" is a claim about order and not about speed. */
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe('the boot drain and the restore that seeds the conversation rows', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetUnackedFrames();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('WITHOUT the hold - the old order - routes a frame before its row exists', async () => {
    // The defect, reproduced: the gate opens on MLS alone and the pull runs at once, both ahead of
    // the restore. Kept as a case so the assertion below is visibly about the hold, not the harness.
    const conversations = new SvelteMap<string, Conversation>();
    const { svc, seen } = makeService(conversations);

    await deliver(svc, 'held');
    await svc.markInboundReady();
    await svc.fetchPendingMessages();
    await restore(conversations, svc);

    expect(seen.routedWithRow).toEqual([false]);
    expect(seen.pullWithRow[0]).toBe(false);
  });

  it('holds every socket frame and the boot pull until the restore has seeded the rows', async () => {
    const conversations = new SvelteMap<string, Conversation>();
    const { svc, seen } = makeService(conversations);

    // The login's order: hold, socket frames, MLS ready, a live frame, the boot pull asked for.
    svc.holdInboundUntilRowsSeeded();
    await deliver(svc, 'before-mls');
    await svc.markInboundReady();
    await deliver(svc, 'after-mls');
    let pulled = false;
    const bootPull = svc.fetchPendingMessages().then(() => (pulled = true));
    await settle();

    expect(seen.routedWithRow).toEqual([]);
    expect(seen.pullWithRow).toEqual([]);
    expect(pulled).toBe(false);

    await restore(conversations, svc);
    await bootPull;
    await settle();

    expect(seen.routedWithRow).toEqual([true, true]);
    expect(seen.pullWithRow).toEqual([true]);
  });

  it('issues the boot pull in the tick of the seeding, so the history phase finds it announced', async () => {
    // The restore's second phase starts right after the seeding and waits for a RUNNING pull at
    // every archive replay's barrier; a pull issued a tick later would be one it could overtake.
    const conversations = new SvelteMap<string, Conversation>();
    const { svc } = makeService(conversations);
    svc.holdInboundUntilRowsSeeded();
    void svc.fetchPendingMessages();

    svc.notifyConversationRowsSeeded();

    expect((svc as unknown as { pendingPullInFlight: unknown }).pendingPullInFlight).not.toBeNull();
  });

  it('routes straight through once seeded - the hold is a cold start, not a session', async () => {
    const conversations = new SvelteMap<string, Conversation>();
    const { svc, seen } = makeService(conversations);
    svc.holdInboundUntilRowsSeeded();
    await svc.markInboundReady();
    await restore(conversations, svc);

    await deliver(svc, 'live');

    expect(seen.routedWithRow).toEqual([true]);
  });

  it('is released by the login when its restore ended without seeding, and says so', async () => {
    // TERMINATION IS A PROOF, NOT THE SEEDING ALONE: a restore that threw before its first phase
    // would otherwise hold every frame, and the boot pull, for the whole session.
    const conversations = new SvelteMap<string, Conversation>();
    const { svc, seen } = makeService(conversations);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    svc.holdInboundUntilRowsSeeded();
    await deliver(svc, 'held');
    await svc.markInboundReady();
    const bootPull = svc.fetchPendingMessages();

    svc.endRowSeedingHold();
    await bootPull;
    await settle();

    expect(seen.routedWithRow).toEqual([false]);
    expect(seen.pullWithRow).toEqual([false]);
    expect(warn.mock.calls.flat().join(' ')).toContain('ended without seeding');
  });

  it('is silent when the seeding already released it - every ordinary boot', async () => {
    const conversations = new SvelteMap<string, Conversation>();
    const { svc } = makeService(conversations);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    svc.holdInboundUntilRowsSeeded();
    await svc.markInboundReady();
    await restore(conversations, svc);

    svc.endRowSeedingHold();

    expect(warn).not.toHaveBeenCalled();
  });

  it('releases the boot pull with nothing listed when the client is destroyed first', async () => {
    const conversations = new SvelteMap<string, Conversation>();
    const { svc, seen } = makeService(conversations);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    svc.holdInboundUntilRowsSeeded();
    const bootPull = svc.fetchPendingMessages();

    svc.destroy();
    await bootPull;

    expect(seen.pullWithRow).toEqual([]);
  });

  it('holds an outbox flush barrier asked during the hold until the rows exist, with no warn', async () => {
    // THE ORDINARY COLD START THAT OWES A DM READ MARK: `registerOutbox` runs after the hold is armed
    // and before the restore, its flush takes `waitForMessageQueueIdle('outbox flush')`, and that
    // barrier pulls. It used to run at once, warned, and listed frames with no row yet.
    const conversations = new SvelteMap<string, Conversation>();
    const { svc, seen } = makeService(conversations);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    svc.holdInboundUntilRowsSeeded();
    await svc.markInboundReady();
    let flushed = false;
    const barrier = svc.waitForMessageQueueIdle('outbox flush', null).then(() => (flushed = true));
    await settle();

    expect(seen.pullWithRow).toEqual([]);
    expect(flushed).toBe(false);

    await restore(conversations, svc);
    await barrier;

    expect(seen.pullWithRow[0]).toBe(true);
    expect(seen.pullWithRow).not.toContain(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('joins a reconnect racing the login to the boot pull, instead of pulling ahead of the rows', async () => {
    // `openGatewayConnection` WITHOUT the login's third argument is the reconnect path: it awaits
    // its pull. While the login's hold is armed that pull is the boot pull, issued by the seeding.
    const conversations = new SvelteMap<string, Conversation>();
    const { svc, seen } = makeService(conversations);
    // THE STEP RIGHT BEFORE THE PULL, as an event: the assertions below are about a reconnect that
    // has reached its pull, not one still in its token fetch.
    let reachedPull!: () => void;
    const atPull = new Promise<void>((r) => (reachedPull = r));
    Object.assign(svc, {
      connect: vi.fn().mockResolvedValue(undefined),
      socketFence: () => 0,
      gatewaySocketSettled: vi.fn().mockResolvedValue(undefined),
      onDisconnect: vi.fn(),
      sendDisconnect: vi.fn(),
      settleUnresolvedCommits: vi.fn(async () => reachedPull()),
    });
    const onCaughtUp = vi.fn();
    svc.holdInboundUntilRowsSeeded();
    await svc.markInboundReady();
    let opened = false;
    const reconnect = openGatewayConnection(connectionDeps(svc, onCaughtUp)).then(
      () => (opened = true)
    );
    await atPull;
    await settle();

    expect(seen.pullWithRow).toEqual([]);
    expect(opened).toBe(false);
    expect(onCaughtUp).not.toHaveBeenCalled();

    await restore(conversations, svc);
    await reconnect;

    expect(seen.pullWithRow[0]).toBe(true);
    expect(seen.pullWithRow).not.toContain(false);
    expect(onCaughtUp).toHaveBeenCalledTimes(1);
  });

  it('does not report a catch-up the destroy released as caught up', async () => {
    // The login's catch-up is handed back started; a failed login destroys the client, which
    // releases the boot pull with nothing listed. The client's own destroyed state - not a clock -
    // is what says nothing was caught up.
    const conversations = new SvelteMap<string, Conversation>();
    const { svc, seen } = makeService(conversations);
    Object.assign(svc, {
      connect: vi.fn().mockResolvedValue(undefined),
      socketFence: () => 0,
      gatewaySocketSettled: vi.fn().mockResolvedValue(undefined),
      onDisconnect: vi.fn(),
      sendDisconnect: vi.fn(),
      settleUnresolvedCommits: vi.fn().mockResolvedValue(undefined),
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onCaughtUp = vi.fn();
    svc.holdInboundUntilRowsSeeded();
    let caughtUp: Promise<void> | null = null;
    await openGatewayConnection(connectionDeps(svc, onCaughtUp), null, (p) => (caughtUp = p));

    svc.destroy();
    await caughtUp;

    expect(seen.pullWithRow).toEqual([]);
    expect(onCaughtUp).not.toHaveBeenCalled();
  });
});

/** The connection deps of `openGatewayConnection` over the real service. */
function connectionDeps(svc: BaseMlsService, onCaughtUp: () => void) {
  return {
    mlsService: svc,
    userId: 'u1',
    deviceKeyB64: 'k',
    scheduleReconnect: vi.fn(),
    setIsWsConnected: vi.fn(),
    setReconnectAttempts: vi.fn(),
    onCaughtUp,
    processDeviceInvitationsLocally: vi.fn().mockResolvedValue(undefined),
    onGroupMissing: vi.fn().mockResolvedValue(undefined),
    onStrandedSeat: vi.fn().mockResolvedValue(undefined),
    log: vi.fn(),
  };
}
