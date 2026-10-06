/**
 * ONE NEW PRIVATE SALON, ONE DISTRIBUTION-GROUP JOIN ON THIS DEVICE - driven through the real
 * entry points, with the real `distributionGroup` module behind them.
 *
 * The backlog filed (2026-08-27) "one client reads a new salon's distribution group TWICE,
 * concurrently": every salon created in the COMM rung was served the `published=false` read twice
 * in one second for one user. Three moments on THIS device reach the salon's group on one gesture:
 *
 *  1. `createNewChannel` itself, once the POST answers;
 *  2. `channel.member.joined`, which social-service publishes to the creator's devices BEFORE it
 *     answers the POST ("a creation is a grant", e54bde85f) - `registerJoinedChannel`;
 *  3. a workspace load that lists the new salon.
 *
 * All three go through `enterPrivateSalonGroup` into `ensureDistributionGroupFor`, whose per-scope
 * in-flight share (67d40e3a0, 2026-08-21, already on the build the entry measured) makes them ONE
 * read and ONE `ensureDistributionGroup`. This file pins that. The second reader of the measurement
 * was therefore not on the creating client: the server line names a USER, not a device, and the
 * same user's OTHER device (A1, the COMM rung's phone) receives the same `channel.member.joined`
 * and must enter the salon's group too (COMM-25). Two devices finding no base is the first-publish
 * race, settled by `stored:false` by design - see channel-encryption.md, "A new private salon,
 * driven end to end".
 */
import { SvelteMap } from 'svelte/reactivity';
import type { DistributionScope } from '$lib/mls-client/distributionScope';

vi.mock('$lib/stores/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/stores/auth')>()),
  getToken: vi.fn().mockResolvedValue('test-token'),
  refresh: vi.fn().mockRejectedValue(new Error('refresh failed')),
  clearAuth: vi.fn(),
}));
vi.mock('$lib/stores/toast.svelte', () => ({ showToast: vi.fn() }));
vi.mock('$lib/utils/chat/channelCrypto', () => ({
  isChannelConversationId: (id: string) => id.startsWith('channel_'),
  sendEncryptedChannelMessage: vi.fn(),
}));
// The roster reconciliation and the history request run after a successful join; their own
// contracts are driven in their own files, and neither reads the group again.
vi.mock('$lib/utils/graine/rosterReconcile', () => ({
  reconcileDistributionGroupRoster: vi.fn().mockResolvedValue([]),
}));
vi.mock('$lib/utils/graine/repair', () => ({
  requestCommunityHistory: vi.fn().mockResolvedValue(undefined),
  releaseRequestsHeldForKeyGroup: vi.fn(),
}));

const WS = 'ws-11111111';
const SALON = 'salon-22222222';

/** Held until every caller has reached the seam, so the three moments really overlap. */
let releaseRead: () => void = () => {};
const salonRead = vi.fn<(scope: DistributionScope) => Promise<unknown>>();
const createChannel = vi.fn();
const listUserWorkspaces = vi.fn();
const listChannels = vi.fn();

vi.mock('$lib/services/ChannelService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/services/ChannelService')>()),
  ChannelService: class MockChannelService {
    createChannel = createChannel;
    listUserWorkspaces = listUserWorkspaces;
    listChannels = listChannels;
    getDistributionGroup = (scope: DistributionScope) =>
      scope.kind === 'channel'
        ? salonRead(scope)
        : // The community is held and current: its own join is not this file's subject.
          Promise.resolve({
            groupId: 'g-community',
            groupInfo: 'c29j',
            baseEpoch: 3,
            activeEpoch: 3,
            memberDevices: ['dev-me'],
          });
  },
}));

import { useChannelWorkspaces, type ChannelWorkspaceContext } from './useChannelWorkspaces.svelte';

function makeMls() {
  const held = new Set<string>(['g-community']);
  return {
    distributionGroupFor: vi.fn((scope: DistributionScope) =>
      scope.kind === 'workspace' ? 'g-community' : null
    ),
    getLocalGroups: vi.fn(() => [...held]),
    ensureDistributionGroup: vi.fn(async (_scope: DistributionScope, ref: { groupId: string }) => {
      held.add(ref.groupId);
      return { joined: true };
    }),
    getEpoch: vi.fn().mockReturnValue(3),
    refreshGroupInfo: vi.fn().mockResolvedValue(null),
    registerDistributionGroup: vi.fn(),
    verifyDistributionEpoch: vi.fn().mockResolvedValue('current'),
    isGroupActive: vi.fn().mockResolvedValue(true),
    getDeviceId: vi.fn().mockReturnValue('dev-me'),
    getDeviceMemberships: vi.fn().mockResolvedValue([]),
    persistCheckpoint: vi.fn().mockResolvedValue(undefined),
  };
}

describe('a private salon created on this device is joined ONCE by this device', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    salonRead.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseRead = () =>
            resolve({
              groupId: 'g-salon',
              groupInfo: null,
              baseEpoch: null,
              activeEpoch: 0,
              memberDevices: [],
            });
        })
    );
    listUserWorkspaces.mockResolvedValue([
      { _id: WS, id: WS, name: 'Community', slug: 'community', imageMediaId: null },
    ]);
    listChannels.mockResolvedValue([
      { _id: SALON, id: SALON, name: 'secret', visibility: 'private', viewerHasAccess: true },
    ]);
  });

  it('the creation, its own channel.member.joined and a workspace load share one read and one join', async () => {
    const mls = makeMls();
    const lines: string[] = [];
    const log = (m: string) => lines.push(m);
    const store = useChannelWorkspaces();
    const ctx: ChannelWorkspaceContext = {
      conversations: new SvelteMap(),
      saveConversation: vi.fn().mockResolvedValue(undefined),
      selectConversation: vi.fn(),
      ensureMls: () => mls as never,
      log,
    };

    let otherMoments: Promise<unknown> = Promise.resolve();
    // The server publishes `channel.member.joined` to the creator's devices before it answers the
    // POST, so the event's handler and a load it may trigger are already running when the creation
    // path resumes - the ordering production has.
    createChannel.mockImplementation(async () => {
      otherMoments = Promise.all([
        store.registerJoinedChannel(SALON, WS, true, ctx.ensureMls, log),
        store.loadChannelWorkspacesFromBackend(ctx),
      ]);
      return { id: SALON, workspaceId: WS, name: 'secret', visibility: 'private' };
    });

    const creation = store.createNewChannel(WS, 'secret', ctx, 'private');

    // EVERY MOMENT HAS REACHED THE SEAM before the read answers: two of them say they are awaiting
    // the first. Without this the test could pass on callers that merely ran one after another.
    const salonLabel = `salon ${SALON.slice(0, 8)}`;
    await vi.waitFor(() =>
      expect(
        lines.filter((l) => l.includes(salonLabel) && l.includes('a join is already in flight'))
          .length
      ).toBe(2)
    );
    releaseRead();
    await creation;
    await otherMoments;

    expect(salonRead).toHaveBeenCalledTimes(1);
    const salonJoins = mls.ensureDistributionGroup.mock.calls.filter(
      ([scope]) => scope.kind === 'channel'
    );
    expect(salonJoins).toHaveLength(1);
    expect(salonJoins[0][0]).toEqual({ kind: 'channel', workspaceId: WS, channelId: SALON });
  });
});
