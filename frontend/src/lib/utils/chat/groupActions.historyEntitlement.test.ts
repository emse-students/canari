import {
  sendFullHistoryBundle,
  sendHistoryBundleForIds,
  sendHistoryRangeBundle,
} from './groupActions';
import { createMlsServiceStub } from '$lib/mls-client/test/fixtures/mlsServiceStub';
import { decodeAppMessage } from '$lib/proto/codec';
import type { IStorage, StoredMessage } from '$lib/db';
import { isInsideExclusion, messageServerTime } from './historyEntitlement';
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

function msg(id: string, serverTimestamp: number | undefined): StoredMessage {
  return {
    id,
    senderId: 'user-c',
    content: 'hello',
    // The sender's clock, deliberately placed OUTSIDE the window for every message: a filter that
    // read it instead of the server time would let `during` through.
    timestamp: 1_600_000_000_000,
    ...(serverTimestamp !== undefined ? { serverTimestamp } : {}),
  } as StoredMessage;
}

const BEFORE = msg('before', T_OUT - 1);
const AT_REMOVAL = msg('at-removal', T_OUT);
const DURING = msg('during', T_OUT + 50_000);
const AT_READD = msg('at-readd', T_BACK);
const AFTER = msg('after', T_BACK + 1);
const UNDATED = msg('undated', undefined);
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

  it('a message with no server time is withheld while any window exists - it cannot be placed', async () => {
    const mlsService = stubWithBobsWindow();
    const log = vi.fn();

    await sendHistoryBundleForIds(
      GROUP,
      ['before', 'undated'],
      { storage: storageWith([BEFORE, UNDATED]), deviceKeyB64: 'k', mlsService, log },
      { to: BOB_NEW_DEVICE, since: 0 }
    );

    expect(sentIds(mlsService)).toEqual(['before']);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('1 with no server time'));
  });

  it('sends NOTHING when the windows cannot be read - silence, never an unfiltered answer', async () => {
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

    expect(mlsService.sendMessage).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('sending nothing'));
  });

  it('a group where nobody was ever out answers EXACTLY as before - a new member and a new device of a continuous member included', async () => {
    const mlsService = createMlsServiceStub(); // no window for anyone

    await sendFullHistoryBundle(GROUP, {
      storage: storageWith([...STORE, UNDATED]),
      deviceKeyB64: 'k',
      mlsService,
      log: vi.fn(),
      to: BOB_NEW_DEVICE,
    });

    expect(sentIds(mlsService)).toEqual([...STORE, UNDATED].map((m) => m.id));
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
