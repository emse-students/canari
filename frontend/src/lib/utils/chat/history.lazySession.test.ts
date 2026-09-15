/**
 * The catch-up session is opened by a frame, never by the possibility of one.
 *
 * `WebMlsService.createDecryptSession` is not a handle: it snapshots the WHOLE MLS client
 * (6 694 960 B on the web client, measured 2026-09-15), ships it to a freshly spawned worker and
 * has that worker rebuild the client before a single page is offered. A reload replays every
 * conversation, so opening one per conversation cost ~127 MB of serialise / transfer / rebuild
 * across nineteen groups - and on the ordinary path, where every row is already accounted for,
 * not one of those sessions decrypted anything.
 *
 * These cases pin both halves: nothing to decrypt opens nothing, and one frame to decrypt opens
 * exactly one session and still commits it.
 */
import { createMlsServiceStub } from '$lib/mls-client/test/fixtures/mlsServiceStub';
import { toBase64 } from '$lib/utils/hex';
import { replayConversationHistory, resetSeenCipherCacheForTests } from './history';

const USER = 'user-1';
const GROUP = 'group-1';
const MY_DEVICE = 'device-test';

const wire = new Uint8Array([0x11, 0x22, 0x33, 0x44, 0x55]);

/** One archive row; `sender_device_id` decides whether the walk even offers it to MLS. */
const rowFrom = (senderDeviceId?: string) => ({
  id: '1786655250946-0',
  sender_id: 'peer',
  sender_device_id: senderDeviceId,
  content: toBase64(wire),
  timestamp: String(1786655250946),
});

beforeEach(() => {
  localStorage.clear();
  resetSeenCipherCacheForTests();
  vi.clearAllMocks();
});

/** Drives one replay over `rows` and hands back the session spies it did or did not use. */
const replay = async (rows: ReturnType<typeof rowFrom>[]) => {
  const decryptPage = vi.fn().mockResolvedValue(rows.map(() => ({ ok: true, plaintext: null })));
  const finish = vi.fn().mockResolvedValue(undefined);
  const createDecryptSession = vi.fn().mockResolvedValue({ decryptPage, finish });
  const mlsService = createMlsServiceStub({
    getLocalGroups: vi.fn().mockReturnValue([GROUP]),
    getDeviceId: vi.fn().mockReturnValue(MY_DEVICE),
    createDecryptSession,
    // The page after the primed one is empty, which is what ends the walk.
    fetchHistory: vi.fn().mockResolvedValue({ rows: [] }),
  });

  await replayConversationHistory({
    mlsService,
    id: GROUP,
    contactName: 'peer',
    userId: USER,
    deviceKeyB64: 'device-key',
    storage: null,
    getConversation: () => undefined,
    setConversation: () => undefined,
    messageReactions: new Map(),
    log: () => undefined,
    primedFirstPage: { rows },
  });

  return { createDecryptSession, decryptPage, finish };
};

describe('the catch-up session opened by an archive replay', () => {
  it('is never opened when the conversation is already at its head', async () => {
    // The ordinary reload: nothing has been appended since the stored cursor. The old code paid a
    // whole-client snapshot and a worker spawn to discover that.
    const { createDecryptSession, finish } = await replay([]);

    expect(createDecryptSession).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
  });

  it('is never opened when every row of the page is this device own traffic', async () => {
    // These rows are recognised before MLS is offered anything - the server carries
    // `sender_device_id` precisely so they are not decrypted. A page of them needs no session.
    const { createDecryptSession } = await replay([rowFrom(MY_DEVICE)]);

    expect(createDecryptSession).not.toHaveBeenCalled();
  });

  it('is opened once, and committed, as soon as one frame actually has to be decrypted', async () => {
    const { createDecryptSession, decryptPage, finish } = await replay([rowFrom('peer-device')]);

    expect(createDecryptSession).toHaveBeenCalledTimes(1);
    expect(createDecryptSession).toHaveBeenCalledWith(GROUP);
    expect(decryptPage).toHaveBeenCalledTimes(1);
    // The commit runs from the replay's outer `finally`, so a session that was opened is always
    // closed - that is what releases the MLS mutex and installs the advanced ratchet.
    expect(finish).toHaveBeenCalledTimes(1);
  });
});
