// @vitest-environment happy-dom
import {
  removeMemberAndBroadcast,
  sendFullHistoryBundle,
  sendHistoryBundleForIds,
  sendHistoryRangeBundle,
} from './groupActions';
import { createMlsServiceStub } from '$lib/mls-client/test/fixtures/mlsServiceStub';
import { decodeAppMessage } from '$lib/proto/codec';
import type { IStorage, StoredMessage } from '$lib/db';
import {
  UNDATED_SKEW_MARGIN_MS,
  isInsideExclusion,
  messageServerTime,
  quotePreviewEntitled,
  withholdReason,
} from './historyEntitlement';
import {
  AddressedUnsupportedError,
  MalformedExclusionsError,
  parseGroupExclusions,
  WithheldUnsupportedError,
} from '$lib/mls-client/mlsDeliveryApi';
import type { FrameDelivery } from '$lib/mls-client/frameDelivery';

/**
 * A REMOVE HOLDS AGAINST A LATER RE-ADD (user, 2026-10-14).
 *
 * The scenario, exactly: Bob is in the group, Bob is removed at T_OUT, the others keep talking,
 * Bob is added back at T_BACK. Whatever device answers Bob must never put a message sent between
 * T_OUT and T_BACK into a bundle. Since step A an answer is ADDRESSED to the device that asked and
 * filtered on that reader's own windows (`withheld`); from a server that predates addressed answers
 * it is a broadcast filtered on the union of every member's gaps, as it was. What preceded the
 * removal and what followed the re-add still goes.
 *
 * The windows come from the SERVER; a message is placed by its server time.
 */
const GROUP = 'g1';
const BOB = 'user-b';
const BOB_NEW_DEVICE = `${BOB}:device-new`;
const ALICE = 'user-a:device-a';

const T_OUT = 1_700_000_100_000;
const T_BACK = 1_700_000_200_000;

function msg(
  id: string,
  serverTimestamp: number | undefined,
  // The sender's clock, by default placed far OUTSIDE the window: a filter that read it instead of
  // the server time would let `during` through.
  timestamp = 1_600_000_000_000
): StoredMessage {
  return {
    id,
    senderId: 'user-c',
    content: 'hello',
    timestamp,
    ...(serverTimestamp !== undefined ? { serverTimestamp } : {}),
  } as StoredMessage;
}

const BEFORE = msg('before', T_OUT - 1);
const AT_REMOVAL = msg('at-removal', T_OUT);
const DURING = msg('during', T_OUT + 50_000);
const AT_READD = msg('at-readd', T_BACK);
const AFTER = msg('after', T_BACK + 1);
const UNDATED = msg('undated', undefined);
/** No server time, and a client clock half an hour before the removal: inside the skew margin. */
const UNDATED_NEAR = msg('undated-near', undefined, T_OUT - 30 * 60_000);
/** No server time and no usable client time either. */
const UNDATABLE = msg('undatable', undefined, 0);
const STORE = [BEFORE, AT_REMOVAL, DURING, AT_READD, AFTER];

function storageWith(messages: StoredMessage[]): IStorage {
  return {
    getMessages: vi.fn().mockResolvedValue(messages),
    getConversation: vi.fn().mockResolvedValue(null),
  } as unknown as IStorage;
}

/** Bob was out between T_OUT and T_BACK - in the union, and in his own `withheld` entry. */
function stubWithBobsWindow() {
  const mlsService = createMlsServiceStub();
  vi.mocked(mlsService.getGroupExclusions).mockResolvedValue(
    new Map([[BOB, [{ from: T_OUT, until: T_BACK }]]])
  );
  vi.mocked(mlsService.getGroupWithheld).mockImplementation(
    async (_g: string, forUserId?: string) =>
      new Map(
        forUserId
          ? [
              [
                forUserId.toLowerCase(),
                forUserId.toLowerCase() === BOB ? [{ from: T_OUT, until: T_BACK }] : [],
              ],
            ]
          : []
      )
  );
  return mlsService;
}

/** How each frame the stub was asked to send was routed. */
function deliveries(mlsService: ReturnType<typeof createMlsServiceStub>): FrameDelivery[] {
  return vi
    .mocked(mlsService.sendMessage)
    .mock.calls.map(([, , , delivery]) => delivery as FrameDelivery);
}

/** The payload of every bundle the stub was asked to send. */
function sentPayloads(mlsService: ReturnType<typeof createMlsServiceStub>) {
  return vi.mocked(mlsService.sendMessage).mock.calls.map(([, bytes]) => {
    const decoded = decodeAppMessage(bytes as Uint8Array);
    return JSON.parse(decoded?.system?.data || '{}') as {
      requestId?: string;
      join?: boolean;
      last?: boolean;
    };
  });
}

const ASK = 'req-00000001';

/** Every message id carried by every bundle the stub was asked to send. */
function sentIds(mlsService: ReturnType<typeof createMlsServiceStub>): string[] {
  return vi.mocked(mlsService.sendMessage).mock.calls.flatMap(([, bytes]) => {
    const decoded = decodeAppMessage(bytes as Uint8Array);
    const data = JSON.parse(decoded?.system?.data || '{}') as { messages?: Array<{ id: string }> };
    return (data.messages ?? []).map((m) => m.id);
  });
}

const EXPECTED_KEPT = ['before', 'at-readd', 'after'];

describe('a Remove holds against a later re-add - every history sender withholds the window', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('the FULL bundle to the re-added member carries what preceded and followed, never the window', async () => {
    const mlsService = stubWithBobsWindow();

    await sendFullHistoryBundle(GROUP, {
      storage: storageWith(STORE),
      deviceKeyB64: 'k',
      mlsService,
      log: vi.fn(),
      to: BOB_NEW_DEVICE,
    });

    expect(sentIds(mlsService)).toEqual(EXPECTED_KEPT);
  });

  it('the DIFF answer withholds the window even when Bob names the ids explicitly', async () => {
    const mlsService = stubWithBobsWindow();

    await sendHistoryBundleForIds(
      GROUP,
      STORE.map((m) => m.id),
      { storage: storageWith(STORE), deviceKeyB64: 'k', mlsService, log: vi.fn() },
      { to: BOB_NEW_DEVICE, since: 0, requestId: ASK }
    );

    expect(sentIds(mlsService)).toEqual(EXPECTED_KEPT);
  });

  it('an answer to ANOTHER member is addressed to that device alone, and carries what THEY may read', async () => {
    const mlsService = stubWithBobsWindow();

    await sendHistoryBundleForIds(
      GROUP,
      STORE.map((m) => m.id),
      { storage: storageWith(STORE), deviceKeyB64: 'k', mlsService, log: vi.fn() },
      { to: ALICE, since: 0, requestId: ASK }
    );

    // Alice was never out: her answer is her whole store, and Bob never receives it.
    expect(sentIds(mlsService)).toEqual(STORE.map((m) => m.id));
    expect(deliveries(mlsService)).toEqual([{ silent: true, durable: false, recipients: [ALICE] }]);
    expect(sentPayloads(mlsService)[0]).toMatchObject({ requestId: ASK, last: true });
  });

  it("from a server that predates addressed answers, the answer is a broadcast and withholds Bob's window", async () => {
    const mlsService = stubWithBobsWindow();
    vi.mocked(mlsService.getAddressedAnswersSupported).mockResolvedValue(false);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await sendHistoryBundleForIds(
      GROUP,
      STORE.map((m) => m.id),
      { storage: storageWith(STORE), deviceKeyB64: 'k', mlsService, log: vi.fn() },
      { to: ALICE, since: 0, requestId: ASK }
    );

    expect(sentIds(mlsService)).toEqual(EXPECTED_KEPT);
    expect(deliveries(mlsService)[0].recipients).toBeUndefined();
    // A fallback is a signal: the first one of the session accuses, at error.
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('predates addressed history answers')
    );
    error.mockRestore();
  });

  it('an ask with no request id (an older client) is not answered addressed - nothing is sent', async () => {
    const mlsService = stubWithBobsWindow();
    const log = vi.fn();

    await sendHistoryBundleForIds(
      GROUP,
      STORE.map((m) => m.id),
      { storage: storageWith(STORE), deviceKeyB64: 'k', mlsService, log },
      { to: ALICE, since: 0 }
    );

    expect(mlsService.sendMessage).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('carries no request id'));
  });

  it('a device the server cannot address is answered nothing - never a broadcast in its place', async () => {
    const mlsService = stubWithBobsWindow();
    vi.mocked(mlsService.sendMessage).mockRejectedValue(
      new AddressedUnsupportedError(GROUP, [ALICE])
    );
    const log = vi.fn();

    await sendHistoryBundleForIds(
      GROUP,
      STORE.map((m) => m.id),
      { storage: storageWith(STORE), deviceKeyB64: 'k', mlsService, log },
      { to: ALICE, since: 0, requestId: ASK }
    );

    expect(mlsService.sendMessage).toHaveBeenCalledTimes(1);
    expect(deliveries(mlsService)[0].recipients).toEqual([ALICE]);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('answering nothing rather than broadcasting')
    );
  });

  it('the SCROLLBACK answer withholds the window', async () => {
    const mlsService = stubWithBobsWindow();

    await sendHistoryRangeBundle(
      GROUP,
      { storage: storageWith(STORE), deviceKeyB64: 'k', mlsService, log: vi.fn() },
      { to: BOB_NEW_DEVICE, before: T_BACK + 10, limit: 50, since: 0, requestId: ASK }
    );

    // The scrollback places by the sender timestamp for its OWN range, and every fixture shares one,
    // so all five are in range; the entitlement then drops the window by server time.
    expect(sentIds(mlsService)).toEqual(EXPECTED_KEPT);
  });

  it('an undated message is placed by its sender clock against the window WIDENED by the margin', async () => {
    const mlsService = stubWithBobsWindow();
    const log = vi.fn();
    const store = [BEFORE, UNDATED, UNDATED_NEAR, UNDATABLE];

    await sendHistoryBundleForIds(
      GROUP,
      store.map((m) => m.id),
      { storage: storageWith(store), deviceKeyB64: 'k', mlsService, log },
      { to: BOB_NEW_DEVICE, since: 0, requestId: ASK }
    );

    // Far from the window: released. Within the margin of it: held. No usable time: held.
    expect(sentIds(mlsService)).toEqual(['before', 'undated']);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('1 undated within 60 min'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('1 undatable'));
  });

  it('the margin is on BOTH sides, and a server time beats a near client clock', () => {
    const w = [{ from: T_OUT, until: T_BACK }];
    const hour = UNDATED_SKEW_MARGIN_MS;
    expect(withholdReason({ timestamp: T_OUT - hour + 1 }, w)).toBe('undated-near-window');
    expect(withholdReason({ timestamp: T_OUT - hour - 1 }, w)).toBeNull();
    expect(withholdReason({ timestamp: T_BACK + hour - 1 }, w)).toBe('undated-near-window');
    expect(withholdReason({ timestamp: T_BACK + hour }, w)).toBeNull();
    expect(withholdReason({ timestamp: T_OUT, serverTimestamp: T_BACK }, w)).toBeNull();
  });

  it('carries NO message when the windows cannot be read - only the state frame an invitee needs', async () => {
    const mlsService = createMlsServiceStub();
    vi.mocked(mlsService.getGroupExclusions).mockRejectedValue(new Error('503'));
    const log = vi.fn();

    await sendFullHistoryBundle(GROUP, {
      storage: storageWith(STORE),
      deviceKeyB64: 'k',
      mlsService,
      log,
      to: BOB_NEW_DEVICE,
    });

    expect(mlsService.sendMessage).toHaveBeenCalledTimes(1);
    expect(sentIds(mlsService)).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('sending no message'));
  });

  it('the DIFF answer sends nothing at all when the windows cannot be read', async () => {
    const mlsService = createMlsServiceStub();
    vi.mocked(mlsService.getGroupExclusions).mockRejectedValue(new Error('503'));

    await sendHistoryBundleForIds(
      GROUP,
      STORE.map((m) => m.id),
      { storage: storageWith(STORE), deviceKeyB64: 'k', mlsService, log: vi.fn() },
      { to: BOB_NEW_DEVICE, since: 0, requestId: ASK }
    );

    expect(mlsService.sendMessage).not.toHaveBeenCalled();
  });

  it('a FULL bundle whose every message is withheld still sends the state frame', async () => {
    const mlsService = stubWithBobsWindow();
    const log = vi.fn();

    await sendFullHistoryBundle(GROUP, {
      storage: storageWith([DURING]),
      deviceKeyB64: 'k',
      mlsService,
      log,
      to: BOB_NEW_DEVICE,
    });

    expect(mlsService.sendMessage).toHaveBeenCalledTimes(1);
    expect(sentIds(mlsService)).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('every message withheld'));
  });

  it('a group where nobody was ever out answers EXACTLY as before - a new member and a new device of a continuous member included', async () => {
    const mlsService = createMlsServiceStub(); // no window for anyone

    await sendFullHistoryBundle(GROUP, {
      storage: storageWith([...STORE, UNDATED, UNDATABLE]),
      deviceKeyB64: 'k',
      mlsService,
      log: vi.fn(),
      to: BOB_NEW_DEVICE,
    });

    expect(sentIds(mlsService)).toEqual([...STORE, UNDATED, UNDATABLE].map((m) => m.id));
  });
});

/**
 * A NEW MEMBER OF A GROUP CONVERSATION READS NOTHING FROM BEFORE THEIR ARRIVAL (user, 2026-10-21).
 *
 * Carol joined the group at T_CAROL; Alice was there from the start. Every answer - the inviter's
 * push and an answer to a request alike - is addressed to its reader and withholds THAT reader's
 * span, so a push to Alice's NEW device carries Alice's whole past and goes to that device alone.
 */
describe('every answer withholds the span before ITS READER arrived', () => {
  const T_ALICE = 1_600_000_000_000;
  /** After DURING (T_OUT + 50 s), before AT_READD (T_BACK). */
  const T_CAROL = 1_700_000_160_000;
  const CAROL_DEVICE = 'user-c2:device-c';
  const ALICE_NEW_DEVICE = 'user-a:device-new';

  function lateJoinerGroup() {
    const mlsService = createMlsServiceStub();
    vi.mocked(mlsService.getGroupExclusions).mockResolvedValue(new Map());
    vi.mocked(mlsService.getGroupWithheld).mockResolvedValue(
      new Map([
        ['user-a', [{ from: 0, until: T_ALICE }]],
        ['user-c2', [{ from: 0, until: T_CAROL }]],
      ])
    );
    return mlsService;
  }

  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('a newcomer is pushed only what was sent from their arrival on', async () => {
    const mlsService = lateJoinerGroup();

    await sendFullHistoryBundle(GROUP, {
      storage: storageWith(STORE),
      deviceKeyB64: 'k',
      mlsService,
      log: vi.fn(),
      to: CAROL_DEVICE,
    });

    // T_CAROL falls between DURING and AT_READD: the span ends exclusive, so `at-readd` goes.
    expect(sentIds(mlsService)).toEqual(['at-readd', 'after']);
    expect(deliveries(mlsService)[0].recipients).toEqual([CAROL_DEVICE]);
    expect(sentPayloads(mlsService)[0]).toMatchObject({ join: true, last: true });
  });

  it("a founding member's NEW device restores everything, ADDRESSED - the newcomer never receives it", async () => {
    const mlsService = lateJoinerGroup();

    await sendFullHistoryBundle(GROUP, {
      storage: storageWith(STORE),
      deviceKeyB64: 'k',
      mlsService,
      log: vi.fn(),
      to: ALICE_NEW_DEVICE,
    });

    expect(sentIds(mlsService)).toEqual(STORE.map((m) => m.id));
    expect(deliveries(mlsService).every((d) => d.recipients?.[0] === ALICE_NEW_DEVICE)).toBe(true);
  });

  it("an answer to the newcomer's REQUEST withholds their span - it is no longer only the push", async () => {
    const mlsService = lateJoinerGroup();

    await sendHistoryBundleForIds(
      GROUP,
      STORE.map((m) => m.id),
      { storage: storageWith(STORE), deviceKeyB64: 'k', mlsService, log: vi.fn() },
      { to: CAROL_DEVICE, since: 0, requestId: ASK }
    );

    expect(sentIds(mlsService)).toEqual(['at-readd', 'after']);
    expect(deliveries(mlsService)[0].recipients).toEqual([CAROL_DEVICE]);
  });

  it('a reader the server does not name is filtered on a SUPERSET - the union and every window it named', async () => {
    // `?for=` is answered only for a person with a device added since we arrived; a reader it does not
    // name arrived before us, so our own span covers theirs.
    const mlsService = lateJoinerGroup();

    await sendFullHistoryBundle(GROUP, {
      storage: storageWith(STORE),
      deviceKeyB64: 'k',
      mlsService,
      log: vi.fn(),
      to: 'user-x:device-x',
    });

    expect(sentIds(mlsService)).toEqual(['at-readd', 'after']);
  });

  it('a server that counts neither the reader nor us is answered nothing - an empty set is no window', async () => {
    const mlsService = lateJoinerGroup();
    vi.mocked(mlsService.getGroupWithheld).mockResolvedValue(new Map());
    const log = vi.fn();

    await sendFullHistoryBundle(GROUP, {
      storage: storageWith(STORE),
      deviceKeyB64: 'k',
      mlsService,
      log,
      to: 'user-x:device-x',
    });

    expect(sentIds(mlsService)).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('counts neither'));
  });

  it('a server that predates addressed answers AND `withheld` keeps the push as it was - the union - and accuses once per session', async () => {
    const mlsService = lateJoinerGroup();
    vi.mocked(mlsService.getAddressedAnswersSupported).mockResolvedValue(false);
    vi.mocked(mlsService.getGroupExclusions).mockResolvedValue(
      new Map([[BOB, [{ from: T_OUT, until: T_BACK }]]])
    );
    vi.mocked(mlsService.getGroupWithheld).mockRejectedValue(new WithheldUnsupportedError(GROUP));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const push = (to: string) =>
      sendFullHistoryBundle(GROUP, {
        storage: storageWith(STORE),
        deviceKeyB64: 'k',
        mlsService,
        log: vi.fn(),
        to,
      });

    await push(ALICE_NEW_DEVICE);
    await push(CAROL_DEVICE);

    // Exactly what the union alone keeps, for a new device and for a newcomer alike, broadcast.
    expect(sentIds(mlsService)).toEqual([...EXPECTED_KEPT, ...EXPECTED_KEPT]);
    expect(deliveries(mlsService).every((d) => d.recipients === undefined)).toBe(true);
    const accusations = error.mock.calls.filter(([l]) =>
      String(l).includes('predates the withheld')
    );
    // Two pushes, one line: the first accusation in this module's session.
    expect(accusations).toHaveLength(1);
    // The addressing accusation was already made by the first legacy answer of this module's
    // session (above), so these two pushes add none.
    expect(
      error.mock.calls.filter(([l]) => String(l).includes('predates addressed history answers'))
    ).toHaveLength(0);
    error.mockRestore();
  });

  it('an unreadable withheld set carries no message to the invitee', async () => {
    const mlsService = lateJoinerGroup();
    vi.mocked(mlsService.getGroupWithheld).mockRejectedValue(new Error('503'));
    const log = vi.fn();

    await sendFullHistoryBundle(GROUP, {
      storage: storageWith(STORE),
      deviceKeyB64: 'k',
      mlsService,
      log,
      to: CAROL_DEVICE,
    });

    expect(sentIds(mlsService)).toEqual([]);
    // One line for the failed read, not one per field.
    const lines = log.mock.calls.map(([l]) => String(l)).filter((l) => l.includes('Cannot read'));
    expect(lines).toHaveLength(1);
  });
});

describe('a long answer reads the windows again for every chunk', () => {
  it('a member re-added mid-answer is withheld from the chunks sealed after it', async () => {
    const mlsService = createMlsServiceStub();
    // Bob had no window when the answer began; his removal-and-re-add lands between the two chunks.
    vi.mocked(mlsService.getGroupWithheld)
      .mockResolvedValueOnce(new Map([[BOB, []]]))
      .mockResolvedValue(new Map([[BOB, [{ from: T_OUT, until: T_BACK }]]]));

    await sendFullHistoryBundle(
      GROUP,
      {
        storage: storageWith([BEFORE, AT_REMOVAL, DURING, AFTER]),
        deviceKeyB64: 'k',
        mlsService,
        log: vi.fn(),
        to: BOB_NEW_DEVICE,
      },
      2
    );

    // Read once per chunk - a single read at the start would have sent `during` in chunk two.
    expect(mlsService.getGroupWithheld).toHaveBeenCalledTimes(2);
    expect(sentIds(mlsService)).toEqual(['before', 'at-removal', 'after']);
    // Only the chunk that closes the answer says so.
    expect(sentPayloads(mlsService).map((p) => p.last === true)).toEqual([false, true]);
  });
});

describe('quotePreviewEntitled - the quote decision itself', () => {
  const deps = (exclusions: Promise<Map<string, { from: number; until: number | null }[]>>) => {
    const mlsService = createMlsServiceStub();
    vi.mocked(mlsService.getGroupExclusions).mockReturnValue(exclusions);
    return { mlsService, log: vi.fn() };
  };
  const bob = () => Promise.resolve(new Map([[BOB, [{ from: T_OUT, until: T_BACK }]]]));

  it('false for a quote from inside any member window, true outside it', async () => {
    expect(await quotePreviewEntitled(GROUP, DURING, deps(bob()))).toBe(false);
    expect(await quotePreviewEntitled(GROUP, BEFORE, deps(bob()))).toBe(true);
    expect(await quotePreviewEntitled(GROUP, AFTER, deps(bob()))).toBe(true);
  });

  it('true when nobody was ever out - even for a message this device does not hold', async () => {
    expect(await quotePreviewEntitled(GROUP, null, deps(Promise.resolve(new Map())))).toBe(true);
  });

  it('false for a message this device does not hold while a window exists - it cannot be placed', async () => {
    expect(await quotePreviewEntitled(GROUP, null, deps(bob()))).toBe(false);
  });

  it('THROWS when the windows cannot be read - a failure is never a decision to blank', async () => {
    await expect(
      quotePreviewEntitled(GROUP, BEFORE, deps(Promise.reject(new Error('503'))))
    ).rejects.toThrow('503');
  });
});

describe('a removal opens its window on the server BEFORE the commit removes the leaf', () => {
  it('records the removal first, then commits', async () => {
    const mlsService = createMlsServiceStub();
    const order: string[] = [];
    // Bob holds a leaf, so the removal owes a commit.
    vi.mocked(mlsService.getGroupMemberIdentities).mockResolvedValue([`${BOB}:d1`]);
    vi.mocked(mlsService.removeMemberFromServer).mockImplementation(async () => {
      order.push('server');
    });
    vi.mocked(mlsService.removeMember).mockImplementation(async () => {
      order.push('commit');
    });

    await removeMemberAndBroadcast({
      mlsService,
      groupId: GROUP,
      memberId: BOB,
      userId: 'user-a',
      deviceKeyB64: 'k',
    });

    expect(order).toEqual(['server', 'commit']);
  });

  it('commits nothing when the server did not record the removal - no window would exist', async () => {
    const mlsService = createMlsServiceStub();
    vi.mocked(mlsService.removeMemberFromServer).mockRejectedValue(new Error('503'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(
      removeMemberAndBroadcast({
        mlsService,
        groupId: GROUP,
        memberId: BOB,
        userId: 'user-a',
        deviceKeyB64: 'k',
      })
    ).rejects.toThrow('503');

    expect(mlsService.removeMember).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[REMOVE_MEMBER]'));
    warn.mockRestore();
  });
});

describe('historyEntitlement - the placement rules', () => {
  it('a window includes its start and excludes its end: the re-add instant belongs to a member', () => {
    const w = [{ from: 10, until: 20 }];
    expect(isInsideExclusion(9, w)).toBe(false);
    expect(isInsideExclusion(10, w)).toBe(true);
    expect(isInsideExclusion(19, w)).toBe(true);
    expect(isInsideExclusion(20, w)).toBe(false);
  });

  it('an open window (still out) covers everything after its start', () => {
    expect(isInsideExclusion(1e15, [{ from: 10, until: null }])).toBe(true);
  });

  it('the server answer is parsed strictly - an unreadable window is a refusal, never "nobody was out"', () => {
    const parsed = parseGroupExclusions({ 'User-B': [{ from: 1, until: null }] });
    expect(parsed.get('user-b')).toEqual([{ from: 1, until: null }]);
    expect(() => parseGroupExclusions({ 'user-b': [{ from: 'x', until: null }] })).toThrow(
      MalformedExclusionsError
    );
    expect(() => parseGroupExclusions(null)).toThrow(MalformedExclusionsError);
  });

  it('the server time is the only clock read - the sender timestamp never places a message', () => {
    expect(messageServerTime({ serverTimestamp: 42 })).toBe(42);
    expect(messageServerTime({})).toBeNull();
    expect(messageServerTime({ serverTimestamp: 0 })).toBeNull();
  });

  // THE CREATOR (2026-10-22): the server no longer gives the person who arrived WITH the group a
  // before-arrival span, so their windows are empty, and an undated message from the group's first
  // hour - inside the margin of the old `[0, creation)` edge - is KEPT. GRP-7 saw it dropped.
  const CREATED = 1_700_000_000_000;

  it('an undated message 10 min after creation is kept for a member with no window', () => {
    expect(withholdReason({ timestamp: CREATED + 10 * 60_000 }, [])).toBeNull();
  });

  it("a joiner's undated message from before their arrival is still withheld", () => {
    const joinerArrival = CREATED + 60 * 60_000;
    const joiner = [{ from: 0, until: joinerArrival }];
    expect(withholdReason({ timestamp: joinerArrival - 10 * 60_000 }, joiner)).toBe(
      'undated-near-window'
    );
  });
});
