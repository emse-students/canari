// @vitest-environment happy-dom
import type { StoredGraineSession } from '$lib/db/types';
import { canari } from '$lib/proto/canari';
import { decodeAppMessage } from '$lib/proto/codec';
import {
  clearEpochGap,
  markEpochGap,
  resetEpochGapRegistry,
} from '$lib/utils/chat/epochGapRegistry';
import {
  forgetWorkspaceRepairState,
  noteHistoryAnswered,
  noteHistoryHeldNothing,
  noteMissingSeed,
  noteSeedUnavailable,
  requestCommunityHistory,
  resetGraineRepairState,
  resolveAnswerer,
  forgetAskedSession,
  releaseRequestsHeldForKeyGroup,
} from './repair';
import { historyHeldNothingFinalAt } from './historyAnswered';
import { noteHistoryPage } from './pagedHistoryAnswer';
import {
  registerChannelWorkspace,
  registerCommunityHistoryVisibility,
  setGraineRuntime,
} from './runtime';
import { flushMacrotask } from '../../../test/flush';

/** When the rows that named a missing session were sent, on the server clock. */
const SENT_AT = Date.parse('2026-08-20T12:00:00Z');

/**
 * Asking for a seed this device does not hold (WP-33).
 *
 * The rules worth a test are the ones whose failure is silent: asking one named answerer rather
 * than the whole community, asking once per session rather than once per unreadable row, and every
 * device picking the SAME stand-in when the sender has left - without talking to each other.
 */

const listMembers = vi.fn();
const listWorkspaceMembers = vi.fn();
const getDistributionGroup = vi.fn();
vi.mock('$lib/services/ChannelService', () => ({
  ChannelService: class {
    listMembers(...args: unknown[]) {
      return listMembers(...args);
    }
    listWorkspaceMembers(...args: unknown[]) {
      return listWorkspaceMembers(...args);
    }
    getDistributionGroup(...args: unknown[]) {
      return getDistributionGroup(...args);
    }
  },
}));

/**
 * The presence waiters the repair parked, in order. Presence itself is not exercised here - the
 * store has its own tests - so a test says "this member came online" by calling the waiter.
 */
let presenceWaiters: { userIds: string[]; fn: (userIds: string[]) => void; cancelled: boolean }[];
vi.mock('$lib/stores/presenceStore', () => ({
  whenAnyComesOnline(userIds: string[], fn: (userIds: string[]) => void) {
    const waiter = { userIds, fn, cancelled: false };
    presenceWaiters.push(waiter);
    return () => {
      waiter.cancelled = true;
    };
  },
}));

/** Fires the live waiter watching `userId`, as the presence store does when they come online. */
function comesOnline(userId: string): void {
  const live = presenceWaiters.filter((w) => !w.cancelled && w.userIds.includes(userId));
  expect(live).toHaveLength(1);
  live[0].cancelled = true;
  live[0].fn([userId]);
}

let sendMessage: ReturnType<typeof vi.fn>;
/** What the fake store answers for the community - empty means "this device has no history". */
let heldSessions: StoredGraineSession[];
/**
 * Which of OUR devices the group holds a row for, as the server would answer it.
 *
 * Defaults to this device alone, which is the state in which we are not a candidate answerer - so
 * every test that is not about our own devices keeps asking exactly what it asked before, and a test
 * that IS about them says so by naming a second one.
 */
let ownDevices: string[];
/** The distribution group's epoch, which is the version of the roster the history ask reads. */
let distributionEpoch: number;
/** The key group's tree as this device holds it, `userId:deviceId` per leaf. */
let treeLeaves: string[];

beforeEach(() => {
  resetGraineRepairState();
  // The durable records (`historyAnswered`, `historyClosedSeen`) are per account in localStorage: a
  // test that recorded a closed past must not leave a widening owed to the next one.
  localStorage.clear();
  presenceWaiters = [];
  // Every member online on one device that is a leaf of the key group, which is what a social
  // service of 1.2.5 answers (`onlineDevices`) and what the tree says (`treeLeaves`).
  const roster = [
    { userId: 'Bob', online: true, onlineDevices: ['web-bob'] },
    { userId: 'alice', online: true, onlineDevices: ['device-1'] },
    { userId: 'carol', online: true, onlineDevices: ['web-carol'] },
  ];
  treeLeaves = ['bob:web-bob', 'alice:device-1', 'carol:web-carol'];
  // CLEARED, NOT JUST RE-STUBBED. These two are module-level `vi.fn()`s, so their call lists were
  // accumulating across the whole file - which means no test here could ever assert a call COUNT,
  // and one that tried would read the previous tests' work as its own.
  listMembers.mockClear();
  listWorkspaceMembers.mockClear();
  listMembers.mockResolvedValue(roster);
  listWorkspaceMembers.mockResolvedValue(roster);
  heldSessions = [];
  ownDevices = ['device-1'];
  distributionEpoch = 7;
  getDistributionGroup.mockImplementation(async () => ({
    groupId: 'dist-group',
    groupInfo: null,
    baseEpoch: null,
    memberDevices: ownDevices,
  }));
  sendMessage = vi.fn().mockResolvedValue(undefined);
  setGraineRuntime({
    storage: {
      getGraineSessionsForWorkspace: async () => heldSessions,
    } as never,
    deviceKey: () => 'device-key',
    userId: 'alice',
    mlsService: {
      sendMessage,
      distributionGroupFor: () => 'dist-group',
      // The drain has settled and the group is current: a request waits on this, and none here is
      // about a group catching up.
      whenDistributionEpochSettled: async () => {},
      getDeviceId: () => 'device-1',
      // The history ask reads the distribution epoch, because "nobody to ask" is an answer about a
      // roster and the epoch is that roster's version. `distributionEpoch` is what a test moves to
      // say the membership changed.
      getLocalGroups: () => ['dist-group'],
      isDistributionBaseSettled: () => true,
      getEpoch: () => distributionEpoch,
      getGroupMemberIdentities: async () => treeLeaves,
    } as never,
  });
  registerChannelWorkspace('chan-1', 'ws-1', false);
  // The community shares its past unless a test says otherwise, so nothing here measures the
  // history boundary by accident - and an unregistered community would fail closed and quietly
  // change what every one of these tests is asking about.
  registerCommunityHistoryVisibility('ws-1', 'shared');
});

afterEach(() => {
  setGraineRuntime(null);
  resetGraineRepairState();
});

/** The flush is started off a microtask, so a test has to let it run before it asserts. */
/**
 * Lets every hop of a flush land. A macrotask rather than a count of microtasks: the election reads
 * the roster and then the key group's tree, and a fixed count silently stopped covering the walk the
 * day a hop was added (1.2.5).
 */
async function settle() {
  await flushMacrotask();
}

describe('noteMissingSeed', () => {
  it('asks the session sender, once, on the distribution group', async () => {
    noteMissingSeed('chan-1', 'sess-1', 'Bob', SENT_AT);
    await settle();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [groupId, payload] = sendMessage.mock.calls[0];
    expect(groupId).toBe('dist-group');
    const request = decodeAppMessage(payload)?.graineRequest;
    expect(request?.answererUserId).toBe('bob');
    expect(request?.sessionIds).toEqual(['sess-1']);
    expect(request?.kind).toBe(canari.GraineRequestKind.GRAINE_REQUEST_KIND_SESSIONS);
  });

  it('asks our own other device for a seed our own other device minted', async () => {
    // THE WHOLE OF COMM-18, END TO END: a salon in a community whose only member is us, one message
    // sent by our laptop, met by a phone that holds no seed for it. Before 2026-08-25 this asked
    // nobody at all and the message stayed unreadable for good.
    listMembers.mockResolvedValue([{ userId: 'alice', online: true }]);
    ownDevices = ['device-1', 'device-2'];

    noteMissingSeed('chan-1', 'sess-1', 'alice', SENT_AT);
    await settle();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const request = decodeAppMessage(sendMessage.mock.calls[0][1])?.graineRequest;
    expect(request?.answererUserId).toBe('alice');
    expect(request?.sessionIds).toEqual(['sess-1']);
  });

  it('never asks for the same session twice', async () => {
    noteMissingSeed('chan-1', 'sess-1', 'bob', SENT_AT);
    await settle();
    noteMissingSeed('chan-1', 'sess-1', 'bob', SENT_AT);
    await settle();

    // A page of fifty unreadable rows names a handful of sessions between them: without this it
    // would be fifty requests, and the answerer would send the same seed fifty times.
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('asks again once the session is explicitly forgotten', async () => {
    noteMissingSeed('chan-1', 'sess-1', 'bob', SENT_AT);
    await settle();
    forgetAskedSession('sess-1');
    noteMissingSeed('chan-1', 'sess-1', 'bob', SENT_AT);
    await settle();

    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('coalesces sessions of one sender into a single request', async () => {
    noteMissingSeed('chan-1', 'sess-1', 'bob', SENT_AT);
    noteMissingSeed('chan-1', 'sess-2', 'bob', SENT_AT);
    await settle();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const request = decodeAppMessage(sendMessage.mock.calls[0][1])?.graineRequest;
    expect(request?.sessionIds).toEqual(['sess-1', 'sess-2']);
  });

  it('sends one request PER answerer, never one broadcast', async () => {
    noteMissingSeed('chan-1', 'sess-1', 'bob', SENT_AT);
    noteMissingSeed('chan-1', 'sess-2', 'carol', SENT_AT);
    await settle();

    expect(sendMessage).toHaveBeenCalledTimes(2);
    const answerers = sendMessage.mock.calls
      .map((c) => decodeAppMessage(c[1])?.graineRequest?.answererUserId)
      .sort();
    expect(answerers).toEqual(['bob', 'carol']);
  });

  it('says out loud that it could not ask, rather than leaving a blank salon unexplained', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    noteMissingSeed('chan-unknown', 'sess-1', 'bob', SENT_AT);
    await settle();

    // The only other symptom is older messages staying unreadable with nothing naming the reason.
    expect(sendMessage).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('leaves the session askable again when the request could not be sent', async () => {
    listMembers.mockRejectedValueOnce(new Error('offline'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    noteMissingSeed('chan-1', 'sess-1', 'bob', SENT_AT);
    await settle();
    expect(sendMessage).not.toHaveBeenCalled();

    // A failed ask that marked the session as asked would be permanent: nothing else ever revisits
    // a session id, so the salon would stay unreadable for the whole app session.
    noteMissingSeed('chan-1', 'sess-1', 'bob', SENT_AT);
    await settle();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

/**
 * A PAST THAT WIDENS (2026-10-22). A member who arrived under `joined` holds seeds floored at their
 * arrival; a switch to `shared` asked nothing again, because the history ask returns once any seed
 * is held - so the setting moved and the members already in never saw the past it opened.
 */
describe('requestCommunityHistory when the community past widens (joined -> shared)', () => {
  const held = [{ sessionId: 's-1' } as never];

  function historyAsks(): canari.GraineRequestMsg.$Properties[] {
    return sendMessage.mock.calls
      .map((call) => decodeAppMessage(call[1])?.graineRequest)
      .filter(
        (r): r is canari.GraineRequestMsg.$Properties =>
          r?.kind === canari.GraineRequestKind.GRAINE_REQUEST_KIND_HISTORY
      );
  }

  /** A fresh app session: memory gone, localStorage kept, the rule read again from the listing. */
  function restartWith(rule: 'shared' | 'joined') {
    resetGraineRepairState();
    registerCommunityHistoryVisibility('ws-1', rule);
  }

  it('asks for the past again though seeds are held, once the rule moved to shared', async () => {
    heldSessions = held;
    registerCommunityHistoryVisibility('ws-1', 'joined');
    await requestCommunityHistory('ws-1');
    expect(historyAsks()).toHaveLength(0);

    registerCommunityHistoryVisibility('ws-1', 'shared');
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await requestCommunityHistory('ws-1');

    expect(historyAsks()).toHaveLength(1);
    expect(historyAsks()[0].answererUserId).toBe('bob');
    expect(info.mock.calls.flat().join(' ')).toContain('reason visibility-widened');
    info.mockRestore();
  });

  it('reaches a device that was offline when the admin flipped it - the closed past is durable', async () => {
    heldSessions = held;
    registerCommunityHistoryVisibility('ws-1', 'joined');
    await requestCommunityHistory('ws-1');

    // Next launch: the listing says `shared`, and nothing in memory says it used to be `joined`.
    restartWith('shared');
    await requestCommunityHistory('ws-1');

    expect(historyAsks()).toHaveLength(1);
  });

  it('is settled by an answer CARRYING SEEDS, and not asked at the next launch', async () => {
    heldSessions = held;
    registerCommunityHistoryVisibility('ws-1', 'joined');
    await requestCommunityHistory('ws-1');
    registerCommunityHistoryVisibility('ws-1', 'shared');
    await requestCommunityHistory('ws-1');
    noteHistoryAnswered('ws-1', String(historyAsks()[0].requestId));

    restartWith('shared');
    await requestCommunityHistory('ws-1');

    expect(historyAsks()).toHaveLength(1);
  });

  it('is asked again at the next launch while nobody has answered it', async () => {
    heldSessions = held;
    registerCommunityHistoryVisibility('ws-1', 'joined');
    await requestCommunityHistory('ws-1');
    registerCommunityHistoryVisibility('ws-1', 'shared');
    await requestCommunityHistory('ws-1');
    // An answer to ANOTHER request settles nothing.
    noteHistoryAnswered('ws-1', 'some-other-request');

    restartWith('shared');
    await requestCommunityHistory('ws-1');

    expect(historyAsks()).toHaveLength(2);
  });

  it('walks to the next member when the first says it holds nothing - held seeds do not stop it', async () => {
    heldSessions = held;
    registerCommunityHistoryVisibility('ws-1', 'joined');
    await requestCommunityHistory('ws-1');
    registerCommunityHistoryVisibility('ws-1', 'shared');
    await requestCommunityHistory('ws-1');

    noteHistoryHeldNothing('ws-1', 'bob', String(historyAsks()[0].requestId), 'web-bob');
    await settle();

    expect(historyAsks().map((r) => r.answererUserId)).toEqual(['bob', 'carol']);
  });

  it('asks again on a LIVE widening after every member said "nothing for you" at this epoch', async () => {
    // No restart: the broadcast (`handleWorkspaceUpdated` -> `requestCommunityHistory`) arrives in
    // the same session, at the same distribution epoch, as the final "nothing" reached under the
    // floor. The in-memory "nobody could answer at this epoch" must not swallow the widened ask.
    registerCommunityHistoryVisibility('ws-1', 'joined');
    await requestCommunityHistory('ws-1');
    noteHistoryHeldNothing('ws-1', 'bob', String(historyAsks()[0].requestId), 'web-bob');
    await settle();
    noteHistoryHeldNothing('ws-1', 'carol', String(historyAsks()[1].requestId), 'web-carol');
    await settle();
    expect(historyHeldNothingFinalAt('alice', 'ws-1', { groupId: 'dist-group', epoch: 7 })).toBe(
      true
    );

    // What the broadcast does: the rule is adopted, then the seed layer is asked.
    registerCommunityHistoryVisibility('ws-1', 'shared');
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await requestCommunityHistory('ws-1');

    expect(historyAsks()).toHaveLength(3);
    expect(info.mock.calls.flat().join(' ')).toContain('reason visibility-widened');
    info.mockRestore();
  });

  it('records no closed past from a rule the server never stated', async () => {
    heldSessions = held;
    // `ws-2`'s rule was never learned in this session: the seed layer reads `joined` for safety,
    // and that reading must not become a "closed past" that the real `shared` would then widen.
    await requestCommunityHistory('ws-2');
    registerCommunityHistoryVisibility('ws-2', 'shared');
    await requestCommunityHistory('ws-2');

    expect(historyAsks()).toHaveLength(0);
  });

  it('owes nothing to a member whose community always shared its past', async () => {
    heldSessions = held;
    await requestCommunityHistory('ws-1');
    restartWith('shared');
    await requestCommunityHistory('ws-1');

    expect(historyAsks()).toHaveLength(0);
  });
});

describe('requestCommunityHistory (WP-34)', () => {
  it('asks the lowest other member, once, when this device holds nothing', async () => {
    await requestCommunityHistory('ws-1');
    await requestCommunityHistory('ws-1');

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const request = decodeAppMessage(sendMessage.mock.calls[0][1])?.graineRequest;
    expect(request?.kind).toBe(canari.GraineRequestKind.GRAINE_REQUEST_KIND_HISTORY);
    // 'alice' is us, so the lowest OTHER member is 'bob'.
    expect(request?.answererUserId).toBe('bob');
    expect(request?.sessionIds ?? []).toHaveLength(0);
  });

  it('asks nothing when this device already holds a seed for the community', async () => {
    heldSessions = [{ sessionId: 's-1' } as never];

    await requestCommunityHistory('ws-1');

    // Derived from the store, not from a "done" flag: it survives a reload, and a device that has
    // history has nothing to catch up on.
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("asks our own other device when we are the community's only member", async () => {
    // COMM-18, 2026-08-25: a phone cold-started into a solo community, met one unreadable message
    // and asked nobody, while the laptop holding the seed sat online in the same group. A community
    // with no second MEMBER still has a second DEVICE, and a request names a user - so it reaches
    // our other devices and only them.
    listMembers.mockResolvedValue([{ userId: 'alice', online: true }]);
    listWorkspaceMembers.mockResolvedValue([{ userId: 'alice', online: true }]);
    ownDevices = ['device-1', 'device-2'];

    await requestCommunityHistory('ws-1');

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(decodeAppMessage(sendMessage.mock.calls[0][1])?.graineRequest?.answererUserId).toBe(
      'alice'
    );
  });

  it('does not ask our own devices when presence says none of them is online', async () => {
    // The Mi 9T, 2026-10-15: `asked <self> (every device) ... no-seed-held` for eight bench
    // communities at every launch, its only other device offline - a transport frame nobody could
    // receive. Presence names our online devices, and here it names only this one.
    const solo = [{ userId: 'alice', online: true, onlineDevices: ['device-1'] }];
    listWorkspaceMembers.mockResolvedValue(solo);
    ownDevices = ['device-1', 'device-2'];
    treeLeaves = ['alice:device-1', 'alice:device-2'];
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await requestCommunityHistory('ws-1');
    await requestCommunityHistory('ws-1');

    expect(sendMessage).not.toHaveBeenCalled();
    // One line for the run, not one per pass.
    expect(info.mock.calls.filter(([m]) => String(m).includes('is not asked'))).toHaveLength(1);
    info.mockRestore();
  });

  it('asks our own other device, by name, once presence says it is online', async () => {
    listWorkspaceMembers.mockResolvedValue([
      { userId: 'alice', online: true, onlineDevices: ['device-1', 'device-2'] },
    ]);
    ownDevices = ['device-1', 'device-2'];
    treeLeaves = ['alice:device-1', 'alice:device-2'];

    await requestCommunityHistory('ws-1');

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const request = decodeAppMessage(sendMessage.mock.calls[0][1])?.graineRequest;
    expect(request?.answererUserId).toBe('alice');
    expect(request?.answererDeviceIds).toEqual(['device-2']);
  });

  it('says so rather than asking when we are alone with a single device', async () => {
    listMembers.mockResolvedValue([{ userId: 'alice', online: true }]);
    listWorkspaceMembers.mockResolvedValue([{ userId: 'alice', online: true }]);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await requestCommunityHistory('ws-1');

    // Nobody to ask and nothing to ask for: the only case where silence is the right answer.
    expect(sendMessage).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalled();
    info.mockRestore();
  });

  /**
   * THE IMPASSE THIS PAIR EXISTS FOR. "Nobody to ask" was filed in the set of communities this
   * session had ASKED, so a request that never went out was recorded as one that did, and the skip
   * lasted the whole session. The only things clearing it were the community leaving the device and
   * a restart - the second being the user getting themselves out, which is exactly what an exit is
   * not allowed to be.
   *
   * The scenario is a phone joining a community while the laptop holding its seeds is offline. No
   * second member, no second device of ours on the group, so nothing is asked. The laptop comes
   * online and joins - which commits to the distribution group and advances its epoch - and the
   * phone showed an empty community until it was restarted.
   */
  it('re-asks once the roster moves, having found nobody to ask', async () => {
    listMembers.mockResolvedValue([{ userId: 'alice', online: true }]);
    listWorkspaceMembers.mockResolvedValue([{ userId: 'alice', online: true }]);

    await requestCommunityHistory('ws-1');
    expect(sendMessage).not.toHaveBeenCalled();

    // The laptop comes online and joins the distribution group: a membership change, so the epoch
    // moves, and with it the only thing the previous answer was ever true of.
    distributionEpoch = 8;
    ownDevices = ['device-1', 'device-2'];

    await requestCommunityHistory('ws-1');

    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('does not re-ask while the roster has not moved, however many passes it gets', async () => {
    listMembers.mockResolvedValue([{ userId: 'alice', online: true }]);
    listWorkspaceMembers.mockResolvedValue([{ userId: 'alice', online: true }]);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await requestCommunityHistory('ws-1');
    await requestCommunityHistory('ws-1');
    await requestCommunityHistory('ws-1');

    // ONE line and ONE roster read for the whole run: an ordinary trigger firing three times asks
    // the same question of the same people, and a second line saying so is the line its reader
    // learns to skip. This is the half the permanent flag was protecting, and it is kept.
    expect(info).toHaveBeenCalledTimes(1);
    expect(listWorkspaceMembers).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
    info.mockRestore();
  });
});

describe('a history ask answered "I hold nothing" (section 24)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  /** The request id, addressee and named devices of the history ask sent `n`-th. */
  function sentAsk(n = 0) {
    const request = decodeAppMessage(sendMessage.mock.calls[n][1])?.graineRequest;
    return {
      requestId: String(request?.requestId),
      answerer: String(request?.answererUserId),
      devices: request?.answererDeviceIds ?? [],
    };
  }

  /** A fresh start: everything in memory goes, what is durable stays. */
  function restart() {
    resetGraineRepairState();
  }

  /** Answers the `n`-th ask "I hold nothing" from every device it named, then lets the walk run. */
  async function answerNothing(n: number) {
    const { requestId, answerer, devices } = sentAsk(n);
    for (const device of devices) noteHistoryHeldNothing('ws-1', answerer, requestId, device);
    await settle();
  }

  it('one member saying "nothing" asks the NEXT member - it is not the roster speaking', async () => {
    await requestCommunityHistory('ws-1');
    expect(sentAsk(0).answerer).toBe('bob');

    await answerNothing(0);

    // Only bob was asked; carol may hold the past, and used to be silenced by bob's answer.
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sentAsk(1).answerer).toBe('carol');
  });

  it('a later start skips the member who answered and asks the one who did not', async () => {
    await requestCommunityHistory('ws-1');
    await answerNothing(0);

    restart();
    await requestCommunityHistory('ws-1');

    expect(sendMessage).toHaveBeenCalledTimes(3);
    expect(sentAsk(2).answerer).toBe('carol');
  });

  it('is FINAL once every eligible member said it: the next start reads nothing, asks nothing', async () => {
    await requestCommunityHistory('ws-1');
    await answerNothing(0);
    await answerNothing(1);
    expect(sendMessage).toHaveBeenCalledTimes(2);

    restart();
    listWorkspaceMembers.mockClear();
    await requestCommunityHistory('ws-1');

    // The Mi 9T asked again at every launch while this answer was a silence (2026-10-15).
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(listWorkspaceMembers).not.toHaveBeenCalled();
  });

  it('a member offline and never asked keeps the ask open, and is asked when it comes online', async () => {
    listWorkspaceMembers.mockResolvedValue([
      { userId: 'bob', online: true, onlineDevices: ['web-bob'] },
      { userId: 'alice', online: true, onlineDevices: ['device-1'] },
      { userId: 'carol', online: false, onlineDevices: [] },
    ]);
    await requestCommunityHistory('ws-1');
    await answerNothing(0);
    expect(sendMessage).toHaveBeenCalledTimes(1);

    listWorkspaceMembers.mockResolvedValue([
      { userId: 'bob', online: true, onlineDevices: ['web-bob'] },
      { userId: 'alice', online: true, onlineDevices: ['device-1'] },
      { userId: 'carol', online: true, onlineDevices: ['web-carol'] },
    ]);
    comesOnline('carol');
    await settle();

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sentAsk(1).answerer).toBe('carol');
  });

  it('asks from the lowest member again once the roster moves, because the answers were about that roster', async () => {
    await requestCommunityHistory('ws-1');
    await answerNothing(0);
    await answerNothing(1);

    restart();
    distributionEpoch = 8;
    await requestCommunityHistory('ws-1');

    expect(sendMessage).toHaveBeenCalledTimes(3);
    expect(sentAsk(2).answerer).toBe('bob');
  });

  it('without the answer, a fresh start still asks the same member - an unanswered ask is not a final one', async () => {
    await requestCommunityHistory('ws-1');
    restart();
    await requestCommunityHistory('ws-1');

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sentAsk(1).answerer).toBe('bob');
  });

  it('ignores an answer to another request, from a member not asked, or from a device not named', async () => {
    await requestCommunityHistory('ws-1');
    const { requestId } = sentAsk();
    noteHistoryHeldNothing('ws-1', 'bob', 'another-request', 'web-bob');
    noteHistoryHeldNothing('ws-1', 'carol', requestId, 'web-carol');
    noteHistoryHeldNothing('ws-1', 'bob', requestId, 'bob-phone');
    await settle();
    expect(sendMessage).toHaveBeenCalledTimes(1);

    restart();
    await requestCommunityHistory('ws-1');

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sentAsk(1).answerer).toBe('bob');
  });

  it('records a member only once EVERY named device has said it - a silent sibling may hold the past', async () => {
    listWorkspaceMembers.mockResolvedValue([
      { userId: 'bob', online: true, onlineDevices: ['web-bob', 'bob-phone'] },
      { userId: 'alice', online: true, onlineDevices: ['device-1'] },
      { userId: 'carol', online: true, onlineDevices: ['web-carol'] },
    ]);
    treeLeaves = ['bob:web-bob', 'bob:bob-phone', 'alice:device-1', 'carol:web-carol'];
    await requestCommunityHistory('ws-1');
    const { requestId, devices } = sentAsk();
    expect([...devices].sort()).toEqual(['bob-phone', 'web-bob']);

    noteHistoryHeldNothing('ws-1', 'bob', requestId, 'web-bob');
    await settle();
    expect(sendMessage).toHaveBeenCalledTimes(1);

    noteHistoryHeldNothing('ws-1', 'bob', requestId, 'bob-phone');
    await settle();
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sentAsk(1).answerer).toBe('carol');
  });

  it('a member whose online phone said "nothing" is NOT answered while a laptop of theirs on the tree is offline - asked when it is online', async () => {
    // bob's laptop is a leaf of the key group and offline: presence names only the phone.
    treeLeaves = ['bob:web-bob', 'bob:bob-laptop', 'alice:device-1', 'carol:web-carol'];
    await requestCommunityHistory('ws-1');
    expect(sentAsk(0)).toMatchObject({ answerer: 'bob', devices: ['web-bob'] });
    await answerNothing(0);
    // The walk moves on - bob's phone is spent - but bob is not recorded as answered.
    expect(sentAsk(1).answerer).toBe('carol');
    await answerNothing(1);

    // Nobody left to ask NOW, and still not final: the laptop may hold the past.
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(historyHeldNothingFinalAt('alice', 'ws-1', { groupId: 'dist-group', epoch: 7 })).toBe(
      false
    );

    // The laptop comes online: the next start asks it, and it alone.
    listWorkspaceMembers.mockResolvedValue([
      { userId: 'bob', online: true, onlineDevices: ['web-bob', 'bob-laptop'] },
      { userId: 'alice', online: true, onlineDevices: ['device-1'] },
      { userId: 'carol', online: true, onlineDevices: ['web-carol'] },
    ]);
    restart();
    await requestCommunityHistory('ws-1');
    expect(sendMessage).toHaveBeenCalledTimes(3);
    expect(sentAsk(2)).toMatchObject({ answerer: 'bob', devices: ['bob-laptop'] });

    // Once it too says "nothing", every device on the tree has: final, no roster read again.
    await answerNothing(2);
    restart();
    listWorkspaceMembers.mockClear();
    await requestCommunityHistory('ws-1');
    expect(sendMessage).toHaveBeenCalledTimes(3);
    expect(listWorkspaceMembers).not.toHaveBeenCalled();
  });

  it('is NOT final while our own other device is on the group and offline, every other member answered', async () => {
    treeLeaves = ['bob:web-bob', 'alice:device-1', 'alice:device-2', 'carol:web-carol'];
    ownDevices = ['device-1', 'device-2'];
    await requestCommunityHistory('ws-1');
    await answerNothing(0);
    await answerNothing(1);
    expect(sendMessage).toHaveBeenCalledTimes(2);

    // Our other device was never asked: it holds the group and may hold the past.
    expect(historyHeldNothingFinalAt('alice', 'ws-1', { groupId: 'dist-group', epoch: 7 })).toBe(
      false
    );
    restart();
    listWorkspaceMembers.mockClear();
    await requestCommunityHistory('ws-1');
    expect(listWorkspaceMembers).toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(2);

    // Online at the next start, it is the one asked.
    listWorkspaceMembers.mockResolvedValue([
      { userId: 'bob', online: true, onlineDevices: ['web-bob'] },
      { userId: 'alice', online: true, onlineDevices: ['device-1', 'device-2'] },
      { userId: 'carol', online: true, onlineDevices: ['web-carol'] },
    ]);
    restart();
    await requestCommunityHistory('ws-1');
    expect(sendMessage).toHaveBeenCalledTimes(3);
    expect(sentAsk(2)).toMatchObject({ answerer: 'alice', devices: ['device-2'] });
  });

  it('a roster member with NO leaf on a known tree holds nothing of it: final without them, never parked on them', async () => {
    // dave is in the community and never signed in: no device, so no leaf of the key group. Every
    // other test here passes only because `treeLeaves` gives each member one.
    const roster = [
      { userId: 'bob', online: true, onlineDevices: ['web-bob'] },
      { userId: 'alice', online: true, onlineDevices: ['device-1'] },
      { userId: 'carol', online: true, onlineDevices: ['web-carol'] },
      { userId: 'dave', online: false, onlineDevices: [] },
    ];
    listWorkspaceMembers.mockResolvedValue(roster);
    await requestCommunityHistory('ws-1');
    await answerNothing(0);
    await answerNothing(1);

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(presenceWaiters.filter((w) => !w.cancelled)).toHaveLength(0);
    expect(historyHeldNothingFinalAt('alice', 'ws-1', { groupId: 'dist-group', epoch: 7 })).toBe(
      true
    );
  });

  it('a leaf naming no device keeps its member on the tree - never final by reading them as leafless', async () => {
    listWorkspaceMembers.mockResolvedValue([
      { userId: 'bob', online: true, onlineDevices: ['web-bob'] },
      { userId: 'alice', online: true, onlineDevices: ['device-1'] },
      { userId: 'carol', online: true, onlineDevices: ['web-carol'] },
      { userId: 'dave', online: false, onlineDevices: [] },
    ]);
    treeLeaves = ['bob:web-bob', 'alice:device-1', 'carol:web-carol', 'dave'];
    await requestCommunityHistory('ws-1');
    await answerNothing(0);
    await answerNothing(1);

    // dave holds the group through a device-less leaf, and may hold the past: waited on, not final.
    expect(historyHeldNothingFinalAt('alice', 'ws-1', { groupId: 'dist-group', epoch: 7 })).toBe(
      false
    );
    expect(presenceWaiters.some((w) => !w.cancelled && w.userIds.includes('dave'))).toBe(true);
  });

  it('counts one device once - the same device answering twice does not walk on', async () => {
    listWorkspaceMembers.mockResolvedValue([
      { userId: 'bob', online: true, onlineDevices: ['web-bob', 'bob-phone'] },
      { userId: 'alice', online: true, onlineDevices: ['device-1'] },
      { userId: 'carol', online: true, onlineDevices: ['web-carol'] },
    ]);
    treeLeaves = ['bob:web-bob', 'bob:bob-phone', 'alice:device-1', 'carol:web-carol'];
    await requestCommunityHistory('ws-1');
    const { requestId } = sentAsk();

    noteHistoryHeldNothing('ws-1', 'bob', requestId, 'web-bob');
    noteHistoryHeldNothing('ws-1', 'bob', requestId, 'web-bob');
    await settle();

    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('after a RE-JOIN asks again whatever was answered - the skipped epochs are gone', async () => {
    await requestCommunityHistory('ws-1');
    await answerNothing(0);
    await answerNothing(1);

    restart();
    await requestCommunityHistory('ws-1', { evenIfSeedsHeld: true });

    expect(sendMessage).toHaveBeenCalledTimes(3);
    expect(sentAsk(2).answerer).toBe('bob');
  });

  it('asks ONCE more, at the next start, when the answer arrived with a page missing (section 4.4)', async () => {
    // The first page made `held` non-empty, which used to end the history ask for good: the lost
    // page was then recovered only session by session, its rows hidden until each repair landed.
    await requestCommunityHistory('ws-1');
    const { requestId } = sentAsk(0);
    noteHistoryPage('alice', 'ws-1', requestId, 'bob', 0, 3);
    noteHistoryPage('alice', 'ws-1', requestId, 'bob', 2, 3);
    heldSessions = [{ sessionId: 's-1' } as never];

    restart();
    await requestCommunityHistory('ws-1');
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(decodeAppMessage(sendMessage.mock.calls[1][1])?.graineRequest?.kind).toBe(
      canari.GraineRequestKind.GRAINE_REQUEST_KIND_HISTORY
    );

    // Its answer arrives in part too: the one re-ask is spent, nothing asks a third time.
    noteHistoryPage('alice', 'ws-1', sentAsk(1).requestId, 'bob', 1, 3);
    restart();
    await requestCommunityHistory('ws-1');
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('asks nothing more at the next start when every page of the answer arrived', async () => {
    await requestCommunityHistory('ws-1');
    const { requestId } = sentAsk(0);
    for (const page of [1, 0]) noteHistoryPage('alice', 'ws-1', requestId, 'bob', page, 2);
    heldSessions = [{ sessionId: 's-1' } as never];

    restart();
    await requestCommunityHistory('ws-1');

    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('forgets the answers when the community leaves this device', async () => {
    await requestCommunityHistory('ws-1');
    await answerNothing(0);
    await answerNothing(1);

    forgetWorkspaceRepairState('ws-1', []);
    restart();
    await requestCommunityHistory('ws-1');

    expect(sendMessage).toHaveBeenCalledTimes(3);
    expect(sentAsk(2).answerer).toBe('bob');
  });
});

describe('resolveAnswerer', () => {
  /** Everyone online - the election as it read before presence, for the tests about its order. */
  const all = (roster: Set<string>) => roster;
  const ask = (answerer: string) => ({ kind: 'ask', answerer });

  it('addresses the sender whenever they are still in the community', () => {
    const roster = new Set(['alice', 'bob', 'carol']);
    expect(resolveAnswerer('Bob', roster, all(roster), 'alice')).toEqual(ask('bob'));
  });

  it('falls back to the lowest user id, which every device computes identically', () => {
    // No clock, no election, nothing for a race to decide: a total order every device already has.
    const roster = new Set(['carol', 'alice', 'bob']);
    expect(resolveAnswerer('dave', roster, all(roster), 'zoe')).toEqual(ask('alice'));
  });

  it('does not address ourselves with no second device to reach', () => {
    // A request reaches the USER it names, so naming ourselves reaches our other devices - and with
    // none, only the device that is asking precisely because it does not hold the seed.
    const roster = new Set(['alice', 'bob']);
    expect(resolveAnswerer('alice', roster, all(roster), 'alice')).toEqual(ask('bob'));
    expect(resolveAnswerer('dave', roster, all(roster), 'alice')).toEqual(ask('bob'));
  });

  it('addresses our own other device FIRST when it minted the session', () => {
    // The sender always holds the seed, and a sender that is our own user is another device of ours:
    // the surest holder in the roster, excluded by name until 2026-08-25 (COMM-18).
    const roster = new Set(['alice', 'bob']);
    expect(resolveAnswerer('alice', roster, all(roster), 'alice', undefined, true)).toEqual(
      ask('alice')
    );
  });

  it('addresses our own other device LAST when a named member could hold it', () => {
    // A device that merely happened to be online is a weaker guess than any named member, so it is
    // the end of the walk rather than the start of it.
    const roster = new Set(['alice', 'bob', 'carol']);
    expect(resolveAnswerer('dave', roster, all(roster), 'alice', undefined, true)).toEqual(
      ask('bob')
    );
    expect(
      resolveAnswerer('dave', roster, all(roster), 'alice', new Set(['bob', 'carol']), true)
    ).toEqual(ask('alice'));
  });

  it('answers exhausted when nobody is left who could hold the seed', () => {
    const exhausted = { kind: 'exhausted' };
    expect(resolveAnswerer('dave', new Set(), new Set(), 'alice')).toEqual(exhausted);
    expect(resolveAnswerer('dave', new Set(['alice']), new Set(['alice']), 'alice')).toEqual(
      exhausted
    );
    // Our own devices are a finite candidate too: asked and declined, the walk still ENDS.
    expect(
      resolveAnswerer('alice', new Set(['alice']), new Set(), 'alice', new Set(['alice']), true)
    ).toEqual(exhausted);
  });

  it('walks past everyone who has already declined, sender included', () => {
    const roster = new Set(['alice', 'bob', 'carol']);
    // Determinism is what makes the election safe and is also what would make it a dead end: the
    // same member would be chosen on every retry. `tried` is what turns one election into a walk.
    expect(resolveAnswerer('bob', roster, all(roster), 'alice', new Set(['bob']))).toEqual(
      ask('carol')
    );
    expect(resolveAnswerer('dave', roster, all(roster), 'alice', new Set(['bob']))).toEqual(
      ask('carol')
    );
    // Exhausted is the PROOF that ends the walk, not a step in it.
    expect(resolveAnswerer('bob', roster, all(roster), 'alice', new Set(['bob', 'carol']))).toEqual(
      { kind: 'exhausted' }
    );
  });

  it('never addresses a member with no device online, sender or stand-in', () => {
    // Production 2026-09-24: a request is transport, dropped for an offline member, and nothing ever
    // replaces a SILENT answerer - so the offline author and the offline lowest id were asked, and
    // the online members holding every seed never were.
    const roster = new Set(['alice', 'bob', 'carol', 'dave']);
    const online = new Set(['alice', 'carol']);
    expect(resolveAnswerer('dave', roster, online, 'alice')).toEqual(ask('carol'));
  });

  it('WAITS on the members who could answer when none of them is online', () => {
    const roster = new Set(['alice', 'bob', 'carol']);
    // Declined members are not waited on: they have already said they hold nothing.
    expect(resolveAnswerer('carol', roster, new Set(['alice']), 'alice', new Set(['bob']))).toEqual(
      { kind: 'wait', offline: ['carol'] }
    );
    expect(resolveAnswerer('carol', roster, new Set(['alice']), 'alice')).toEqual({
      kind: 'wait',
      offline: ['bob', 'carol'],
    });
  });
});

describe('the returner (production 2026-09-24)', () => {
  /**
   * The case measured end to end: a member leaves an 8-member community and comes back through its
   * link. Leaving dropped their seeds. The lowest id and the salon's authors are OFFLINE, other
   * members online hold every seed. Before the fix every request went to an offline member and the
   * salon stayed blank on both devices.
   */
  const returnerRoster = [
    { userId: 'alice', online: true }, // us, back
    { userId: 'bob', online: false }, // the lowest other id, offline for two days
    { userId: 'carol', online: true }, // online, holds the shared past
    { userId: 'dave', online: false }, // an author, offline for weeks
  ];

  beforeEach(() => {
    listMembers.mockResolvedValue(returnerRoster);
    listWorkspaceMembers.mockResolvedValue(returnerRoster);
  });

  it('asks an ONLINE member for the history, not the offline lowest id', async () => {
    await requestCommunityHistory('ws-1');

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(decodeAppMessage(sendMessage.mock.calls[0][1])?.graineRequest?.answererUserId).toBe(
      'carol'
    );
    expect(listWorkspaceMembers).toHaveBeenCalledWith('ws-1', { presence: true });
  });

  it("asks an ONLINE member for an offline author's session", async () => {
    noteMissingSeed('chan-1', 'sess-dave', 'dave', SENT_AT);
    await settle();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(decodeAppMessage(sendMessage.mock.calls[0][1])?.graineRequest?.answererUserId).toBe(
      'carol'
    );
    expect(listMembers).toHaveBeenCalledWith('chan-1', 'workspace', { presence: true });
  });

  it('asks nobody while every holder is offline, then asks the one who comes back', async () => {
    const offlineRoster = returnerRoster.map((m) => ({ ...m, online: m.userId === 'alice' }));
    listMembers.mockResolvedValue(offlineRoster);
    noteMissingSeed('chan-1', 'sess-dave', 'dave', SENT_AT);
    await settle();
    // A frame to nobody is not an ask: the want waits, on presence and not on a clock.
    expect(sendMessage).not.toHaveBeenCalled();
    expect(presenceWaiters.map((w) => w.userIds)).toEqual([['bob', 'carol', 'dave']]);

    listMembers.mockResolvedValue(
      offlineRoster.map((m) => ({ ...m, online: m.userId === 'alice' || m.userId === 'dave' }))
    );
    comesOnline('dave');
    await settle();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(decodeAppMessage(sendMessage.mock.calls[0][1])?.graineRequest?.answererUserId).toBe(
      'dave'
    );
  });

  it('keeps ONE waiter per channel however many batches find nobody', async () => {
    listMembers.mockResolvedValue(returnerRoster.map((m) => ({ ...m, online: false })));
    noteMissingSeed('chan-1', 'sess-1', 'dave', SENT_AT);
    await settle();
    noteMissingSeed('chan-1', 'sess-2', 'carol', SENT_AT);
    await settle();

    // The second batch joined the first rather than stacking a second waiter over the same people.
    expect(presenceWaiters.filter((w) => !w.cancelled)).toHaveLength(1);

    listMembers.mockResolvedValue(returnerRoster);
    comesOnline('carol');
    await settle();
    const request = decodeAppMessage(sendMessage.mock.calls[0][1])?.graineRequest;
    expect(request?.answererUserId).toBe('carol');
    expect(request?.sessionIds?.slice().sort()).toEqual(['sess-1', 'sess-2']);
  });

  it('parks the history request too, and asks once a member is back', async () => {
    const offlineRoster = returnerRoster.map((m) => ({ ...m, online: m.userId === 'alice' }));
    listWorkspaceMembers.mockResolvedValue(offlineRoster);

    await requestCommunityHistory('ws-1');
    expect(sendMessage).not.toHaveBeenCalled();

    listWorkspaceMembers.mockResolvedValue(returnerRoster);
    comesOnline('carol');
    await settle();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(decodeAppMessage(sendMessage.mock.calls[0][1])?.graineRequest?.kind).toBe(
      canari.GraineRequestKind.GRAINE_REQUEST_KIND_HISTORY
    );
  });

  it('elects as if online a member the server gave no presence for, and says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    listMembers.mockResolvedValue([{ userId: 'alice' }, { userId: 'bob' }]);
    noteMissingSeed('chan-1', 'sess-bob', 'bob', SENT_AT);
    await settle();

    expect(decodeAppMessage(sendMessage.mock.calls[0][1])?.graineRequest?.answererUserId).toBe(
      'bob'
    );
    expect(warn.mock.calls.flat().join(' ')).toContain('without presence');
    warn.mockRestore();
  });
});

describe('a community that closes its past (WP-34)', () => {
  /**
   * ASKING FOR WHAT WE MAY NOT BE GIVEN COSTS THE WHOLE GROUP. The rule was broadcast to this
   * device and our own arrival is one roster fetch away, so a request for a session whose every
   * message predates us is a frame every member decrypts to learn what we already knew - and the
   * answer is silence, so it would go out again at the next start.
   *
   * This is NOT where the rule is enforced: the answerer places the boundary itself and refuses.
   * This is only what keeps an honest client off the group.
   */
  const ARRIVED = Date.parse('2026-08-20T12:00:00Z');

  beforeEach(() => {
    registerCommunityHistoryVisibility('ws-1', 'joined');
    listWorkspaceMembers.mockResolvedValue([
      { userId: 'Bob', joinedAt: '2026-01-01T00:00:00Z' },
      { userId: 'alice', joinedAt: '2026-08-20T12:00:00Z' },
    ]);
  });

  it('does not ask for a session whose messages all predate our arrival', async () => {
    noteMissingSeed('chan-1', 'sess-old', 'bob', ARRIVED - 60_000);
    await settle();

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('still asks for a session seen after our arrival', async () => {
    noteMissingSeed('chan-1', 'sess-new', 'bob', ARRIVED + 60_000);
    await settle();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const request = decodeAppMessage(sendMessage.mock.calls[0][1])?.graineRequest;
    expect(request?.sessionIds).toEqual(['sess-new']);
  });

  it('keeps a session whose NEWEST row is on our side of the arrival', async () => {
    // Rotation makes the test exact rather than approximate - a join advances the distribution
    // group's epoch and every sender rotates on the next send, so no session spans an arrival.
    // Taking the newest row is what makes a mixed pair resolve the safe way for the member.
    noteMissingSeed('chan-1', 'sess-1', 'bob', ARRIVED - 60_000);
    noteMissingSeed('chan-1', 'sess-1', 'bob', ARRIVED + 60_000);
    await settle();

    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('asks anyway when our own arrival cannot be read', async () => {
    // Fail-OPEN here, and only here: refusing to ask because a roster fetch failed would strand
    // seeds we are entitled to, for the saving of one frame - and the answerer refuses regardless.
    listWorkspaceMembers.mockRejectedValue(new Error('offline'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    noteMissingSeed('chan-1', 'sess-old', 'bob', ARRIVED - 60_000);
    await settle();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe('noteSeedUnavailable', () => {
  /** Reads the user id a request frame was addressed to. */
  function requestIdOf(call: unknown[]): string {
    return String(decodeAppMessage(call[1] as Uint8Array)?.graineRequest?.requestId ?? '');
  }

  function answererOf(call: unknown[]): string {
    return String(decodeAppMessage(call[1] as Uint8Array)?.graineRequest?.answererUserId ?? '');
  }

  it('elects the next member when the chosen answerer does not hold the seed', async () => {
    // Sender 'dave' has left, so the roster decides: bob is the lowest id that is not us.
    noteMissingSeed('chan-1', 'sess-1', 'dave', SENT_AT);
    await settle();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(answererOf(sendMessage.mock.calls[0])).toBe('bob');

    // Without this the session was unreadable for the WHOLE app session: bob is elected by every
    // device alike, so a silent "I don't have it" stranded it for good.
    noteSeedUnavailable('sess-1', 'bob', requestIdOf(sendMessage.mock.calls.at(-1)!), 'web-bob');
    await settle();
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(answererOf(sendMessage.mock.calls[1])).toBe('carol');
  });

  it('stops on the roster being exhausted, and says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    noteMissingSeed('chan-1', 'sess-1', 'dave', SENT_AT);
    await settle();

    noteSeedUnavailable('sess-1', 'bob', requestIdOf(sendMessage.mock.calls.at(-1)!), 'web-bob');
    await settle();
    noteSeedUnavailable(
      'sess-1',
      'carol',
      requestIdOf(sendMessage.mock.calls.at(-1)!),
      'web-carol'
    );
    await settle();

    // Two members, two asks, then nothing: the walk ends on a PROOF that nobody holds it - not on a
    // counter and not on a clock - and the give-up is logged rather than left as a blank salon.
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.flat().join(' ')).toContain('no reachable holder');
    warn.mockRestore();
  });

  it('with no device named, takes ONE answer per member - a second device declining changes nothing', async () => {
    // A roster without per-device presence names nobody, so every device of bob answers and nobody
    // can tell how many will: the first "no" strikes him, as before 1.2.5.
    listMembers.mockResolvedValue([
      { userId: 'Bob', online: true },
      { userId: 'alice', online: true },
      { userId: 'carol', online: true },
    ]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    noteMissingSeed('chan-1', 'sess-1', 'dave', SENT_AT);
    await settle();

    noteSeedUnavailable('sess-1', 'bob', requestIdOf(sendMessage.mock.calls.at(-1)!), 'web-bob');
    await settle();
    noteSeedUnavailable('sess-1', 'BOB', requestIdOf(sendMessage.mock.calls.at(-1)!), 'tauri-bob');
    await settle();

    // bob's laptop and phone both said no: one line, one move down the roster to carol.
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(info.mock.calls.flat().filter((l) => String(l).includes('does not hold'))).toHaveLength(
      1
    );
    info.mockRestore();
    warn.mockRestore();
  });

  describe('a member with two named devices (section 23)', () => {
    beforeEach(() => {
      listMembers.mockResolvedValue([
        { userId: 'Bob', online: true, onlineDevices: ['tauri-bob', 'web-bob'] },
        { userId: 'alice', online: true, onlineDevices: ['device-1'] },
        { userId: 'carol', online: true, onlineDevices: ['web-carol'] },
      ]);
      treeLeaves = ['bob:tauri-bob', 'bob:web-bob', 'alice:device-1', 'carol:web-carol'];
    });

    /** The session ids a request frame named. */
    function sessionsOf(call: unknown[]): string[] {
      return (decodeAppMessage(call[1] as Uint8Array)?.graineRequest?.sessionIds ?? []).map(String);
    }

    it('strikes the member on the FIRST decline from a named device - a silent one never holds the walk', async () => {
      // Waiting for every named device re-created the stall the device list exists to avoid: a
      // backgrounded phone named and silent, and nothing to wake it (re-review of #1768, D-A).
      const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
      noteMissingSeed('chan-1', 'sess-1', 'dave', SENT_AT);
      await settle();
      const ask = requestIdOf(sendMessage.mock.calls[0]);

      noteSeedUnavailable('sess-1', 'bob', ask, 'web-bob');
      await settle();
      expect(sendMessage).toHaveBeenCalledTimes(2);
      expect(answererOf(sendMessage.mock.calls[1])).toBe('carol');

      // bob's other named device saying no too, and the same one repeating, move nothing.
      noteSeedUnavailable('sess-1', 'bob', ask, 'tauri-bob');
      noteSeedUnavailable('sess-1', 'bob', ask, 'web-bob');
      await settle();
      expect(sendMessage).toHaveBeenCalledTimes(2);
      info.mockRestore();
    });

    it('re-asks only the session declined when one request carried two and the other landed', async () => {
      const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
      noteMissingSeed('chan-1', 'sess-1', 'dave', SENT_AT);
      noteMissingSeed('chan-1', 'sess-2', 'dave', SENT_AT);
      await settle();
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sessionsOf(sendMessage.mock.calls[0]).sort()).toEqual(['sess-1', 'sess-2']);
      const ask = requestIdOf(sendMessage.mock.calls[0]);

      // The device's one bundle: it held sess-2 (stored, which ends that walk) and declined sess-1.
      forgetAskedSession('sess-2');
      noteSeedUnavailable('sess-1', 'bob', ask, 'web-bob');
      await settle();

      expect(sendMessage).toHaveBeenCalledTimes(2);
      expect(answererOf(sendMessage.mock.calls[1])).toBe('carol');
      expect(sessionsOf(sendMessage.mock.calls[1])).toEqual(['sess-1']);
      info.mockRestore();
    });

    it('stops at the seed when another named device delivers it after the strike - no further ask, no false alarm', async () => {
      // The accepted cost of striking early: one ask to carol. Then bob's laptop answers late with the
      // seed, which is stored whoever asked, and that ends the walk - carol's "no" changes nothing.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
      noteMissingSeed('chan-1', 'sess-1', 'dave', SENT_AT);
      await settle();
      noteSeedUnavailable('sess-1', 'bob', requestIdOf(sendMessage.mock.calls[0]), 'tauri-bob');
      await settle();
      expect(sendMessage).toHaveBeenCalledTimes(2);

      forgetAskedSession('sess-1');
      noteSeedUnavailable('sess-1', 'carol', requestIdOf(sendMessage.mock.calls[1]), 'web-carol');
      await settle();

      expect(sendMessage).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls.flat().join(' ')).not.toContain('no reachable holder');
      warn.mockRestore();
      info.mockRestore();
    });

    it('ignores a late decline of the first ask once the walk has re-asked', async () => {
      const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
      noteMissingSeed('chan-1', 'sess-1', 'dave', SENT_AT);
      await settle();
      const first = requestIdOf(sendMessage.mock.calls[0]);
      noteSeedUnavailable('sess-1', 'bob', first, 'tauri-bob');
      await settle();
      expect(answererOf(sendMessage.mock.calls[1])).toBe('carol');

      // bob's laptop answers the superseded ask: it may not move the walk on from carol.
      noteSeedUnavailable('sess-1', 'bob', first, 'web-bob');
      await settle();
      expect(sendMessage).toHaveBeenCalledTimes(2);
      info.mockRestore();
    });
  });

  it('ignores a decline from a device of the member that the request did not name', async () => {
    noteMissingSeed('chan-1', 'sess-1', 'dave', SENT_AT);
    await settle();

    // Only `web-bob` was named; another device of bob has no standing in this walk.
    noteSeedUnavailable('sess-1', 'bob', requestIdOf(sendMessage.mock.calls[0]), 'tauri-other');
    await settle();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('asks nobody on behalf of a session that is no longer wanted', async () => {
    // The seed landed by the durable log between the ask and this answer. Re-electing here would
    // spend a round trip on a session this device already holds.
    noteMissingSeed('chan-1', 'sess-1', 'dave', SENT_AT);
    await settle();
    forgetAskedSession('sess-1');

    noteSeedUnavailable('sess-1', 'bob', requestIdOf(sendMessage.mock.calls.at(-1)!), 'web-bob');
    await settle();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('lets a later miss ask again once the seed has been forgotten', async () => {
    noteMissingSeed('chan-1', 'sess-1', 'dave', SENT_AT);
    await settle();
    // Still armed: a second unreadable row naming the same session must not become a second ask.
    noteMissingSeed('chan-1', 'sess-1', 'dave', SENT_AT);
    await settle();
    expect(sendMessage).toHaveBeenCalledTimes(1);

    forgetAskedSession('sess-1');
    noteMissingSeed('chan-1', 'sess-1', 'dave', SENT_AT);
    await settle();
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('ignores a decline from a member the ask was not addressed to, even quoting the right id', async () => {
    noteMissingSeed('chan-1', 'sess-1', 'dave', SENT_AT);
    await settle();
    expect(answererOf(sendMessage.mock.calls[0])).toBe('bob');

    // carol was never elected: she may not strike herself off the roster and trigger a re-ask.
    noteSeedUnavailable('sess-1', 'carol', requestIdOf(sendMessage.mock.calls[0]), 'web-carol');
    await settle();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('ignores a decline of a request that is not the one in flight (a replay from the durable log)', async () => {
    // Declines are durable since 2026-10-10, so one can come back from the distribution group's log
    // after its ask was superseded. Counting it would strike a member who was never asked in THIS walk.
    noteMissingSeed('chan-1', 'sess-1', 'dave', SENT_AT);
    await settle();
    expect(answererOf(sendMessage.mock.calls[0])).toBe('bob');

    noteSeedUnavailable('sess-1', 'bob', 'a-request-from-a-past-walk', 'web-bob');
    await settle();
    expect(sendMessage).toHaveBeenCalledTimes(1);

    // The real answer to the ask in flight still moves the walk on.
    noteSeedUnavailable('sess-1', 'bob', requestIdOf(sendMessage.mock.calls[0]), 'web-bob');
    await settle();
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(answererOf(sendMessage.mock.calls[1])).toBe('carol');
  });
});

/**
 * Nothing is asked at an epoch the key group is about to leave (production, 2026-09-28: a device at
 * epoch 5 of a key group every member had at 13 sealed its requests there, and nobody could read
 * them).
 */
describe('a key group behind its epoch', () => {
  afterEach(() => resetEpochGapRegistry());

  it('holds a seed request while the gap is armed, and sends it when the group catches up', async () => {
    markEpochGap('dist-group');
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    noteMissingSeed('chan-1', 'sess-1', 'bob', SENT_AT);
    await settle();
    expect(sendMessage).not.toHaveBeenCalled();

    clearEpochGap('dist-group');
    releaseRequestsHeldForKeyGroup('dist-group');
    await settle();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(decodeAppMessage(sendMessage.mock.calls[0][1])?.graineRequest?.sessionIds).toEqual([
      'sess-1',
    ]);
    info.mockRestore();
  });

  it('asks AGAIN for what went out at an epoch the group has since left', async () => {
    distributionEpoch = 5;
    noteMissingSeed('chan-1', 'sess-1', 'bob', SENT_AT);
    await settle();
    expect(sendMessage).toHaveBeenCalledTimes(1);

    // The group caught up past the epoch the request was sealed at.
    distributionEpoch = 13;
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    releaseRequestsHeldForKeyGroup('dist-group');
    await settle();

    expect(sendMessage).toHaveBeenCalledTimes(2);
    info.mockRestore();
  });

  it('does not re-ask what was sealed at the epoch the group is at', async () => {
    noteMissingSeed('chan-1', 'sess-1', 'bob', SENT_AT);
    await settle();

    releaseRequestsHeldForKeyGroup('dist-group');
    await settle();

    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('holds the history request too, and asks once the group has caught up', async () => {
    markEpochGap('dist-group');
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await requestCommunityHistory('ws-1');
    expect(sendMessage).not.toHaveBeenCalled();

    clearEpochGap('dist-group');
    releaseRequestsHeldForKeyGroup('dist-group');
    await settle();

    expect(decodeAppMessage(sendMessage.mock.calls[0][1])?.graineRequest?.kind).toBe(
      canari.GraineRequestKind.GRAINE_REQUEST_KIND_HISTORY
    );
    info.mockRestore();
  });

  it('after a RE-JOIN asks the history even though seeds are held - the skipped epochs are gone', async () => {
    heldSessions = [{ sessionId: 'held' } as StoredGraineSession];
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await requestCommunityHistory('ws-1');
    expect(sendMessage).not.toHaveBeenCalled();

    releaseRequestsHeldForKeyGroup('dist-group', 'ws-1');
    await settle();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    info.mockRestore();
  });
});

describe('the answering devices, and the reason on every ask (section 23)', () => {
  /** Decodes the request a send carried. */
  function requestOf(call: unknown[]) {
    return decodeAppMessage(call[1] as Uint8Array)?.graineRequest;
  }

  it('names EVERY online device of the elected member that is a leaf of the key group', async () => {
    // Every one, never the lowest: the lowest was a backgrounded phone whose socket stays open and
    // whose script does not run, and a silent named device never moves the walk (review of #1768).
    listMembers.mockResolvedValue([
      { userId: 'bob', online: true, onlineDevices: ['tauri-b1', 'web-b2', 'web-b3'] },
      { userId: 'alice', online: true, onlineDevices: ['device-1'] },
    ]);
    // `tauri-b1` is online but never joined this key group, so it could not read the request.
    treeLeaves = ['bob:web-b2', 'bob:web-b3', 'alice:device-1'];

    noteMissingSeed('chan-1', 'sess-1', 'bob', SENT_AT);
    await settle();

    expect(requestOf(sendMessage.mock.calls[0])?.answererUserId).toBe('bob');
    expect(requestOf(sendMessage.mock.calls[0])?.answererDeviceIds).toEqual(['web-b2', 'web-b3']);
  });

  it('names at most 16 devices, the limit the delivery service accepts on an addressed frame', async () => {
    const many = Array.from({ length: 20 }, (_, i) => `web-${String(i).padStart(2, '0')}`);
    listMembers.mockResolvedValue([
      { userId: 'bob', online: true, onlineDevices: many },
      { userId: 'alice', online: true, onlineDevices: ['device-1'] },
    ]);
    treeLeaves = [...many.map((d) => `bob:${d}`), 'alice:device-1'];

    noteMissingSeed('chan-1', 'sess-1', 'bob', SENT_AT);
    await settle();

    expect(requestOf(sendMessage.mock.calls[0])?.answererDeviceIds).toEqual(many.slice(0, 16));
  });

  it('passes over a member whose only online device is not on the key group', async () => {
    // Elected anyway, such a member is a request nobody can read - WP-33's silent answerer.
    listMembers.mockResolvedValue([
      { userId: 'bob', online: true, onlineDevices: ['web-new'] },
      { userId: 'carol', online: true, onlineDevices: ['web-carol'] },
      { userId: 'alice', online: true, onlineDevices: ['device-1'] },
    ]);
    treeLeaves = ['carol:web-carol', 'alice:device-1'];

    noteMissingSeed('chan-1', 'sess-1', 'dave', SENT_AT);
    await settle();

    expect(requestOf(sendMessage.mock.calls[0])?.answererUserId).toBe('carol');
    expect(requestOf(sendMessage.mock.calls[0])?.answererDeviceIds).toEqual(['web-carol']);
  });

  it('names no device, and says why, when the roster predates per-device presence', async () => {
    listMembers.mockResolvedValue([
      { userId: 'bob', online: true },
      { userId: 'alice', online: true },
    ]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    noteMissingSeed('chan-1', 'sess-1', 'bob', SENT_AT);
    await settle();

    // Every device of bob answers, exactly as before 1.2.5 - never a request that reaches nobody.
    expect(requestOf(sendMessage.mock.calls[0])?.answererUserId).toBe('bob');
    expect(requestOf(sendMessage.mock.calls[0])?.answererDeviceIds ?? []).toEqual([]);
    expect(warn.mock.calls.flat().join(' ')).toContain('without per-device presence');
    warn.mockRestore();
  });

  it('names the answering device on a HISTORY request too', async () => {
    await requestCommunityHistory('ws-1');

    expect(requestOf(sendMessage.mock.calls[0])?.answererUserId).toBe('bob');
    expect(requestOf(sendMessage.mock.calls[0])?.answererDeviceIds).toEqual(['web-bob']);
  });

  it('says on the ask line WHY it asks, at which epoch, and what the key group lost', async () => {
    // F3 of the 2026-10-12 queue audit: 185 or more asks in 37 minutes on one key group, against 22
    // new sessions, and no line could say why.
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    noteMissingSeed('chan-1', 'sess-1', 'dave', SENT_AT);
    await settle();
    const first = info.mock.calls.flat().find((l) => String(l).includes('[GRAINE] asked bob'));
    expect(String(first)).toContain('at epoch 7');
    expect(String(first)).toContain('reasons unreadable-row=1');
    expect(String(first)).toContain('key group lost none this session');

    info.mockClear();
    noteSeedUnavailable(
      'sess-1',
      'bob',
      String(requestOf(sendMessage.mock.calls.at(-1)!)?.requestId ?? ''),
      'web-bob'
    );
    await settle();
    const second = info.mock.calls.flat().find((l) => String(l).includes('[GRAINE] asked carol'));
    expect(String(second)).toContain('reasons declined=1');
    info.mockRestore();
  });
});
