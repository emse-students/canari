// @vitest-environment happy-dom
/**
 * The archive replay notes THE SERVER'S OWN TIME into `serverClock` (third review of #2824, 1).
 *
 * A device that joined every group by external commit and restored everything from the history-log
 * replay received no live frame, so `serverClock` held nothing and `serverMarkCeiling` was 0: no
 * server read mark could move until the first frame, and a conversation read in that window showed
 * its badge again after a restart. Each archive row's `timestamp` is the `receivedAt` the delivery
 * service stamped - the server's word - and it is what the replay now notes. Nothing a frame's
 * plaintext says (a read mark's `at`, a relayed row) reaches the clock.
 */
import { createMlsServiceStub } from '$lib/mls-client/test/fixtures/mlsServiceStub';
import { toBase64 } from '$lib/utils/hex';
import { encodeAppMessage, mkSystem } from '$lib/proto/codec';
import {
  newestServerRowTime,
  replayConversationHistory,
  resetSeenCipherCacheForTests,
} from './history';
import { readMarkTarget } from './readState';
import { resetServerClockForTests, serverTimeSeen } from './serverClock';

const USER = 'user-1';
const GROUP = 'group-1';
const MY_DEVICE = 'device-test';
const T1 = 1_786_655_250_946;
const T2 = T1 + 60_000;
/** A date no server has stamped yet. */
const YEAR_2100 = 4_102_444_800_000;

const row = (n: number, at: number, senderDeviceId = 'peer-device', senderId = 'peer') => ({
  id: `${at}-${n}`,
  sender_id: senderId,
  sender_device_id: senderDeviceId,
  content: toBase64(new Uint8Array([0x10, n])),
  timestamp: new Date(at).toISOString(),
});

beforeEach(() => {
  localStorage.clear();
  resetSeenCipherCacheForTests();
  resetServerClockForTests();
  vi.clearAllMocks();
});

/** One replay of `rows`, each decrypted to `plaintexts[i]` (null: a frame with no payload). */
const replay = async (
  rows: ReturnType<typeof row>[],
  plaintexts: Array<Uint8Array | null> = rows.map(() => null)
) => {
  const mlsService = createMlsServiceStub({
    getLocalGroups: vi.fn().mockReturnValue([GROUP]),
    getDeviceId: vi.fn().mockReturnValue(MY_DEVICE),
    createDecryptSession: vi.fn().mockResolvedValue({
      decryptPage: vi
        .fn()
        .mockResolvedValue(
          plaintexts.map((plaintext) => ({ ok: true, plaintext, sender: 'peer:peer-device' }))
        ),
      finish: vi.fn().mockResolvedValue(undefined),
    }),
    fetchHistory: vi.fn().mockResolvedValue({ rows: [] }),
  });
  await replayConversationHistory({
    mlsService,
    id: GROUP,
    contactName: 'peer',
    userId: USER,
    deviceKey: () => 'device-key',
    storage: null,
    getConversation: () => undefined,
    setConversation: () => undefined,
    messageReactions: new Map(),
    log: () => undefined,
    primedFirstPage: { rows },
  });
};

describe('the archive replay and the server clock', () => {
  it('notes the newest time the server stamped on the rows it replayed', async () => {
    expect(serverTimeSeen(USER)).toBe(0);
    await replay([row(1, T1), row(2, T2)]);

    expect(serverTimeSeen(USER)).toBe(T2);
  });

  it('a restored device can mark read before its first live frame', async () => {
    await replay([row(1, T1), row(2, T2)]);
    const held = [
      {
        isOwn: false,
        isSystem: false,
        senderId: 'peer',
        timestamp: new Date(T2 - 5),
        serverTimestamp: T2,
      },
    ];

    // Before the fix the ceiling was 0 and the mark stayed where it was.
    expect(readMarkTarget(held, 0, false, serverTimeSeen(USER))).toBe(T2);
  });

  it('notes the rows this device sent too, which it never decrypts', async () => {
    await replay([row(1, T2, MY_DEVICE, USER)]);

    expect(serverTimeSeen(USER)).toBe(T2);
  });

  it('never above what the server stamped, whatever a replayed frame claims', async () => {
    // A member's read mark claiming the year 2100 on both clocks, relayed in a row the server
    // stamped at T1: the clock takes T1, never the frame's word.
    const plaintext = encodeAppMessage(
      mkSystem('read_watermark', JSON.stringify({ at: YEAR_2100, serverAt: YEAR_2100 }))
    );
    await replay([row(1, T1)], [plaintext]);

    expect(serverTimeSeen(USER)).toBe(T1);
  });

  it('never moves the clock back', async () => {
    await replay([row(1, T2)]);
    resetSeenCipherCacheForTests();
    await replay([row(2, T1)]);

    expect(serverTimeSeen(USER)).toBe(T2);
  });
});

describe('newestServerRowTime', () => {
  it('reads the server stamp of each row and ignores one that states none', () => {
    expect(
      newestServerRowTime([
        { timestamp: new Date(T2).toISOString() },
        { timestamp: 'not a date' },
        {},
        { timestamp: new Date(T1).toISOString() },
      ])
    ).toBe(T2);
    expect(newestServerRowTime([])).toBeUndefined();
  });
});
