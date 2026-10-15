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
import { MalformedExclusionsError, parseGroupExclusions } from '$lib/mls-client/mlsDeliveryApi';

/**
 * A REMOVE HOLDS AGAINST A LATER RE-ADD (user, 2026-10-14).
 *
 * The scenario, exactly: Bob is in the group, Bob is removed at T_OUT, the others keep talking,
 * Bob is added back at T_BACK. Whatever device answers a history request must never put a message
 * sent between T_OUT and T_BACK into a bundle - a bundle is a broadcast, so that holds whoever the
 * bundle is addressed to. What preceded the removal and what followed the re-add still goes.
 *
 * The windows come from the SERVER (`getGroupExclusions`); a message is placed by its server time.
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

/** Bob was out between T_OUT and T_BACK. */
function stubWithBobsWindow() {
  const mlsService = createMlsServiceStub();
  vi.mocked(mlsService.getGroupExclusions).mockResolvedValue(
    new Map([[BOB, [{ from: T_OUT, until: T_BACK }]]])
  );
  return mlsService;
}

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
      { to: BOB_NEW_DEVICE, since: 0 }
    );

    expect(sentIds(mlsService)).toEqual(EXPECTED_KEPT);
  });

  it("an answer to ANOTHER member withholds Bob's window too - Bob decrypts every broadcast", async () => {
    const mlsService = stubWithBobsWindow();

    await sendHistoryBundleForIds(
      GROUP,
      STORE.map((m) => m.id),
      { storage: storageWith(STORE), deviceKeyB64: 'k', mlsService, log: vi.fn() },
      { to: ALICE, since: 0 }
    );

    expect(sentIds(mlsService)).not.toContain('during');
  });

  it('the SCROLLBACK answer withholds the window', async () => {
    const mlsService = stubWithBobsWindow();

    await sendHistoryRangeBundle(
      GROUP,
      { storage: storageWith(STORE), deviceKeyB64: 'k', mlsService, log: vi.fn() },
      { to: BOB_NEW_DEVICE, before: T_BACK + 10, limit: 50, since: 0 }
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
      { to: BOB_NEW_DEVICE, since: 0 }
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
      { to: BOB_NEW_DEVICE, since: 0 }
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

describe('a long answer reads the windows again for every chunk', () => {
  it('a member re-added mid-answer is withheld from the chunks sealed after it', async () => {
    const mlsService = createMlsServiceStub();
    // Nobody had a window when the answer began; Bob's re-add lands between the two chunks.
    vi.mocked(mlsService.getGroupExclusions)
      .mockResolvedValueOnce(new Map())
      .mockResolvedValue(new Map([[BOB, [{ from: T_OUT, until: T_BACK }]]]));

    await sendFullHistoryBundle(
      GROUP,
      {
        storage: storageWith([BEFORE, AT_REMOVAL, DURING, AFTER]),
        deviceKeyB64: 'k',
        mlsService,
        log: vi.fn(),
        to: ALICE,
      },
      2
    );

    // Read once per chunk - a single read at the start would have sent `during` in chunk two.
    expect(mlsService.getGroupExclusions).toHaveBeenCalledTimes(2);
    expect(sentIds(mlsService)).toEqual(['before', 'at-removal', 'after']);
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
});
