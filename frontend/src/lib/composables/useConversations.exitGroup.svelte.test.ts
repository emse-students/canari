/**
 * Leaving or deleting a group must state the departure locally BEFORE it performs it remotely.
 *
 * The row used to be purged at the very end of `exitGroupAndCleanup`, so for the whole span of the
 * server call, the WASM forget and the state persist that follow it, a conversation this device had
 * irrevocably given up still read as live. `loadGroupMembers` is fired by a `$effect` over the
 * conversations map and the leave path writes into that map itself (the `memberLeft` system
 * message), so a roster request went out for a group whose server-side membership had just been
 * revoked - a `GET /api/mls/groups/:id/members -> 403` in the leaver's console, intermittent by
 * nature, and the third time that endpoint was asked a question it is certain to refuse.
 *
 * THE TEST ASKS FOR THE ROSTER FROM INSIDE THE WINDOW, which is the only way to observe the defect:
 * asserting the final state passes on the broken code too, because the row does get purged in the
 * end. The window is where the two paths overlapped, so the window is where the assertion belongs.
 */
import { SvelteMap } from 'svelte/reactivity';
import type { Conversation } from '$lib/types';

const isGroupActiveOnServer = vi.hoisted(() => vi.fn());
const leaveGroupAndBroadcast = vi.hoisted(() => vi.fn());
const deleteGroupAndBroadcast = vi.hoisted(() => vi.fn());
const purgeOrphanGroup = vi.hoisted(() => vi.fn());
const fetchUniqueGroupMembers = vi.hoisted(() => vi.fn());

vi.mock('$lib/utils/chat/groupActions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/utils/chat/groupActions')>();
  return {
    ...actual,
    isGroupActiveOnServer,
    leaveGroupAndBroadcast,
    deleteGroupAndBroadcast,
    purgeOrphanGroup,
    fetchUniqueGroupMembers,
  };
});

// Same isolation reasoning as the other composable tests: `useConversations` is reachable from the
// global chat singleton's own module-scope instantiation, so importing it directly closes a cycle.
vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  globalSession: {},
  globalConvs: {},
  globalMessaging: {},
  globalChannels: {},
  globalNotifs: {},
  appendLog: vi.fn(),
}));

const { useConversations } = await import('./useConversations.svelte');

const CONTACT = 'Les Canaris';
const GROUP_ID = 'e4c1f0aa-0000-4000-8000-000000000009';

function conversation(): Conversation {
  return {
    id: GROUP_ID,
    name: CONTACT,
    messages: [],
    lifecycle: 'active',
    conversationType: 'group',
  } as unknown as Conversation;
}

function makeCtx() {
  const log = vi.fn();
  const mls = {
    dismissGroup: vi.fn().mockResolvedValue(undefined),
    getLocalGroups: () => [GROUP_ID],
    getDeviceId: () => 'dev-1',
  };
  return {
    log,
    mls,
    ctx: {
      storage: null,
      ensureMls: () => mls,
      userId: 'u1',
      deviceKeyB64: 'k',
      messageReactions: new SvelteMap(),
      log,
      addMessageToChat: vi.fn(),
    } as never,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  isGroupActiveOnServer.mockResolvedValue(true);
  purgeOrphanGroup.mockResolvedValue(undefined);
  fetchUniqueGroupMembers.mockResolvedValue(['u1', 'u2']);
});

describe('exitGroupAndCleanup - the departure is recorded before it is performed', () => {
  /**
   * Runs one exit and reports what the roster loader saw while the server action was in flight.
   *
   * The server action is where the observation has to happen: it is the first irreversible step,
   * and everything after it - the WASM forget, the persist - only widens the window it opens.
   */
  async function observeDuringServerAction(
    broadcast: typeof leaveGroupAndBroadcast,
    run: (convs: ReturnType<typeof useConversations>, ctx: never) => Promise<void>
  ) {
    const convs = useConversations();
    convs.conversations.set(CONTACT, conversation());
    convs.selectConversation(CONTACT);
    const { ctx, log } = makeCtx();

    const seen: { lifecycle: unknown; selected: string | null } = {
      lifecycle: undefined,
      selected: 'not-observed',
    };
    broadcast.mockImplementation(async () => {
      seen.lifecycle = convs.conversations.get(CONTACT)?.lifecycle;
      seen.selected = convs.selectedContact;
      // The roster loader, from inside the window, exactly as the `$effect` would fire it.
      await convs.loadGroupMembers(GROUP_ID, ctx);
    });

    await run(convs, ctx);
    return { convs, seen, log };
  }

  it('leaving retires the row and drops the selection before broadcasting', async () => {
    const { seen } = await observeDuringServerAction(leaveGroupAndBroadcast, (convs, ctx) =>
      convs.handleLeaveGroup(ctx)
    );

    expect(leaveGroupAndBroadcast).toHaveBeenCalledOnce();
    expect(seen.lifecycle).toBe('removed');
    expect(seen.selected).toBeNull();
  });

  it('does not ask the members-only endpoint for the roster of a group being left', async () => {
    const { log } = await observeDuringServerAction(leaveGroupAndBroadcast, (convs, ctx) =>
      convs.handleLeaveGroup(ctx)
    );

    // The 403 GRP-6 recorded: the request itself, not the way it was handled.
    expect(fetchUniqueGroupMembers).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('not requested - conversation retired')
    );
  });

  it('deleting retires the row before broadcasting the deletion', async () => {
    const { seen } = await observeDuringServerAction(deleteGroupAndBroadcast, (convs, ctx) =>
      convs.handleDeleteGroup(ctx)
    );

    expect(deleteGroupAndBroadcast).toHaveBeenCalledOnce();
    expect(seen.lifecycle).toBe('removed');
    expect(fetchUniqueGroupMembers).not.toHaveBeenCalled();
  });

  it('still purges the row afterwards - retiring is the window, not the end state', async () => {
    const { convs } = await observeDuringServerAction(leaveGroupAndBroadcast, (c, ctx) =>
      c.handleLeaveGroup(ctx)
    );

    expect(purgeOrphanGroup).toHaveBeenCalledWith(
      expect.objectContaining({ contactKey: CONTACT, groupId: GROUP_ID })
    );
    // `purgeOrphanGroup` is mocked, so the row is still here: what this asserts is that the exit
    // hands it the same key it retired, which is what makes the retire transient rather than final.
    expect(convs.conversations.get(CONTACT)?.lifecycle).toBe('removed');
  });

  it('retires even when the group is already gone from the server', async () => {
    // The server action is SKIPPED on this branch, and the local statement must not be skipped with
    // it: the device is out either way, and the row is what every other reader consults.
    isGroupActiveOnServer.mockResolvedValue(false);
    const convs = useConversations();
    convs.conversations.set(CONTACT, conversation());
    convs.selectConversation(CONTACT);
    const { ctx } = makeCtx();

    await convs.handleLeaveGroup(ctx);

    expect(leaveGroupAndBroadcast).not.toHaveBeenCalled();
    expect(convs.conversations.get(CONTACT)?.lifecycle).toBe('removed');
    expect(convs.selectedContact).toBeNull();
  });
});
