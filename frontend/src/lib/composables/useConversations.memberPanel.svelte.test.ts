// @vitest-environment happy-dom
/**
 * The group settings panel lists who the ROSTER says is in the group, the moment the Add that
 * admitted them returns - every person of a bulk Add, not only those whose device has already
 * opened its Welcome.
 *
 * Seen twice by the cross-client rig (1.4.1-alpha.3): a creator bulk-added two people in ONE commit,
 * the server held both on the roster, and the creator's open panel read two members and offered a
 * remove button for ONE invitee only. The panel was fed from `GET .../members`, which answers the
 * devices whose membership is `active` - a state the INVITEE's client writes when it processes its
 * Welcome, on its own clock. The commit itself writes `pending` rows, so the list read right after
 * the Add held whichever invitee happened to be quick, and nothing ever read it again.
 *
 * THE FAKE SERVER BELOW KEEPS BOTH TABLES, AS THE REAL ONE DOES: the user-level roster
 * (`registerMember`), and the device rows the commit writes `pending` and only the invitee's own
 * client promotes. One invitee activates during the Add, the other is offline - the second sighting.
 */
import { SvelteMap } from 'svelte/reactivity';
import type { Conversation } from '$lib/types';

vi.mock('$lib/users/blocks', () => ({ isBlockedWith: vi.fn(async () => false) }));
vi.mock('$lib/utils/users/displayName', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/users/displayName')>()),
  resolveDisplayNames: async () => (id: string) => id,
}));
// Same isolation reasoning as the other composable tests: `useConversations` is reachable from the
// global chat singleton's own module-scope instantiation, so importing it directly closes a cycle.
vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  globalSession: {},
  globalConvs: {},
  globalMessaging: { isMessageCatchupActive: false, resetMessageCatchupState: vi.fn() },
  globalChannels: {},
  globalNotifs: {},
  appendLog: vi.fn(),
}));

const { useConversations } = await import('./useConversations.svelte');

const CONTACT = 'Les Canaris';
const GROUP_ID = 'e4c1f0aa-0000-4000-8000-00000000000a';

function conversation(): Conversation {
  return {
    id: GROUP_ID,
    name: CONTACT,
    messages: [],
    lifecycle: 'active',
    conversationType: 'group',
  } as unknown as Conversation;
}

/** The delivery service's two membership tables, and the one MLS fact the Add reads. */
function makeServer() {
  const roster = new Set<string>(['u1']);
  const devices = new Map<string, { userId: string; status: 'pending' | 'active' }>([
    ['u1-dev', { userId: 'u1', status: 'active' }],
  ]);
  const tree = new Set<string>(['u1:u1-dev']);
  const mls = {
    getDeviceId: () => 'u1-dev',
    getLocalGroups: () => [GROUP_ID],
    registerMember: vi.fn(async (_g: string, u: string) => {
      roster.add(u);
    }),
    fetchUserDevices: vi.fn(async (u: string) => [{ deviceId: `${u}-dev` }]),
    acquireAddLock: vi.fn(async () => true),
    releaseAddLock: vi.fn(async () => {}),
    getGroupMemberIdentities: vi.fn(async () => [...tree]),
    runUnderMlsLock: vi.fn((fn: () => Promise<unknown>) => fn()),
    // ONE commit admits both devices: the server writes their rows `pending` (`admits`).
    addMembersBulk: vi.fn(async (_g: string, kps: { deviceId: string; userId: string }[]) => {
      for (const kp of kps) {
        tree.add(`${kp.userId}:${kp.deviceId}`);
        devices.set(kp.deviceId, { userId: kp.userId, status: 'pending' });
      }
      return {
        addedDeviceIds: kps.map((kp) => kp.deviceId),
        skipped: [],
        welcome: new Uint8Array([1]),
      };
    }),
    // The quick invitee opens its Welcome at once and promotes its own row; the other is offline.
    sendWelcome: vi.fn(async (_w: unknown, owner: string, _g: string, did: string) => {
      if (owner === 'bob') devices.set(did, { userId: owner, status: 'active' });
    }),
    sendMessage: vi.fn(async () => {}),
    getGroupMembers: vi.fn(async () =>
      [...devices]
        .filter(([, row]) => row.status === 'active')
        .map(([deviceId, row]) => ({ userId: row.userId, deviceId }))
    ),
    getGroupUserMembers: vi.fn(async () => [...roster].map((userId) => ({ userId }))),
    getGroupRosterAtGeneration: vi.fn(async () => ({
      members: [...roster].map((userId) => ({ userId })),
      seatGeneration: 0,
    })),
  };
  return { mls, roster };
}

function makeCtx(mls: ReturnType<typeof makeServer>['mls']) {
  return {
    storage: null,
    ensureMls: () => mls,
    userId: 'u1',
    deviceKeyB64: 'k',
    historyBaseUrl: 'https://example.invalid',
    messageReactions: new SvelteMap(),
    log: vi.fn(),
    addMessageToChat: vi.fn(async () => {}),
  } as never;
}

describe('the group panel after a bulk Add', () => {
  it('lists every person the commit admitted, whether or not their device opened its Welcome', async () => {
    const { mls, roster } = makeServer();
    const convs = useConversations();
    convs.conversations.set(CONTACT, conversation());
    convs.selectConversation(CONTACT);
    const ctx = makeCtx(mls);

    await convs.inviteMembersToCurrentGroup(['bob', 'carol'], ctx);

    expect([...roster].sort()).toEqual(['bob', 'carol', 'u1']);
    expect([...convs.groupMembers].sort()).toEqual(['bob', 'carol', 'u1']);
  });

  it('does not list a person whose seat still awaits a member admission', async () => {
    const { mls } = makeServer();
    mls.getGroupUserMembers = vi.fn(async () => [
      { userId: 'u1' },
      { userId: 'dave', awaitingAdmission: true },
    ]);
    const convs = useConversations();
    convs.conversations.set(CONTACT, conversation());
    convs.selectConversation(CONTACT);

    await convs.loadGroupMembers(GROUP_ID, makeCtx(mls));

    expect(convs.groupMembers).toEqual(['u1']);
  });
});
