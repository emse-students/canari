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
import { GroupExitRefusedError } from '$lib/mls-client/mlsDeliveryApi';

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

/**
 * The pending-exit table, in memory. Only the three methods this path uses, because a row that
 * SURVIVES is the whole assertion: DEL-10 lost a deletion precisely by clearing it on no answer.
 */
function makeExitStorage() {
  const rows = new Map<string, unknown>();
  return {
    rows,
    // The exit path persists the retired row and deletes it on purge. Present here because a
    // storage that is non-null must answer everything this path asks it, not only the new table.
    saveConversation: vi.fn(async () => undefined),
    deleteConversation: vi.fn(async () => undefined),
    savePendingGroupExit: vi.fn(async (e: { groupId: string }) => {
      rows.set(e.groupId, e);
    }),
    getPendingGroupExits: vi.fn(async () => [...rows.values()]),
    deletePendingGroupExit: vi.fn(async (groupId: string) => {
      rows.delete(groupId);
    }),
  };
}

function makeCtx(storage: ReturnType<typeof makeExitStorage> | null = null) {
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
      storage,
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

/**
 * DEL-10, the other half: what the exit does when the server never answers.
 *
 * The row purge above is deliberate and stays - the user is out locally the moment they ask. What
 * used to be wrong is what happened to the SERVER side of the exit: a `try/catch` read "the server
 * said 404" and "there was no server" as one outcome and purged either way, so a deletion attempted
 * offline was lost, the group survived server-side, and discovery handed it straight back.
 */
describe('exitGroupAndCleanup - an exit the server never answered stays owed', () => {
  const NET = new TypeError('Failed to fetch');

  async function exitWith(
    broadcast: typeof leaveGroupAndBroadcast,
    impl: (storage: ReturnType<typeof makeExitStorage>) => Promise<void>,
    run: 'leave' | 'delete'
  ) {
    const convs = useConversations();
    convs.conversations.set(CONTACT, conversation());
    convs.selectConversation(CONTACT);
    const storage = makeExitStorage();
    // Handed to the implementation rather than closed over: a closure over the caller's `const`
    // would sit in its TDZ and throw from inside the server action, which the exit would then
    // classify as a refusal - a failure with nothing to do with the code under test.
    broadcast.mockImplementation(() => impl(storage));
    const { ctx, log } = makeCtx(storage);
    if (run === 'leave') await convs.handleLeaveGroup(ctx);
    else await convs.handleDeleteGroup(ctx);
    return { storage, log, convs };
  }

  it('writes the row BEFORE the call, which is what makes the loss recoverable', async () => {
    let owedDuringCall: unknown[] = [];
    const { storage } = await exitWith(
      deleteGroupAndBroadcast,
      async (s) => {
        owedDuringCall = await s.getPendingGroupExits();
        throw NET;
      },
      'delete'
    );
    // Recorded before the request went out - a row written afterwards would never exist for the one
    // call that fails.
    expect(owedDuringCall).toEqual([
      expect.objectContaining({ groupId: GROUP_ID, kind: 'delete' }),
    ]);
    // Deliberately declared after the assertion above so the closure order is the tested one.
    expect(storage.savePendingGroupExit).toHaveBeenCalledOnce();
  });

  it('keeps the row when the server was unreachable, and accuses in the log', async () => {
    const { storage, log } = await exitWith(
      deleteGroupAndBroadcast,
      async () => {
        throw NET;
      },
      'delete'
    );
    expect(storage.rows.has(GROUP_ID)).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('INJOIGNABLE'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('rejouee a la reconnexion'));
  });

  it('clears the row once the server has answered', async () => {
    const { storage } = await exitWith(deleteGroupAndBroadcast, async () => {}, 'delete');
    expect(storage.rows.size).toBe(0);
    expect(storage.deletePendingGroupExit).toHaveBeenCalledWith(GROUP_ID);
  });

  it('clears the row when the server says the exit already happened', async () => {
    const { storage, log } = await exitWith(
      leaveGroupAndBroadcast,
      async () => {
        throw new GroupExitRefusedError(GROUP_ID, 403, 'leave');
      },
      'leave'
    );
    expect(storage.rows.size).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Deja fait cote serveur'));
  });

  // A reachable server refusing is a defect to find, not a decision to forget - so the row stays,
  // and the line says which of the two failures it was rather than blaming the link.
  it('keeps the row when a reachable server refuses', async () => {
    const { storage, log } = await exitWith(
      leaveGroupAndBroadcast,
      async () => {
        throw new GroupExitRefusedError(GROUP_ID, 500, 'leave');
      },
      'leave'
    );
    expect(storage.rows.has(GROUP_ID)).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('REFUS'));
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('INJOIGNABLE'));
  });

  // The local exit is NOT conditional on the server: the user asked, and the row they see must go
  // whatever the network did. Only the server half is owed afterwards.
  it('retires and purges locally even when nothing reached the server', async () => {
    const { convs } = await exitWith(
      deleteGroupAndBroadcast,
      async () => {
        throw NET;
      },
      'delete'
    );
    expect(purgeOrphanGroup).toHaveBeenCalledWith(
      expect.objectContaining({ contactKey: CONTACT, groupId: GROUP_ID })
    );
    expect(convs.conversations.get(CONTACT)?.lifecycle).toBe('removed');
  });
});
