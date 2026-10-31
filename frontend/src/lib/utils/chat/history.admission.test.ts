// @vitest-environment happy-dom
/**
 * A COMMIT BRINGING A NEW USER INTO A CLOSED GROUP, MET BY THE ARCHIVE REPLAY.
 *
 * It is the third place the refusal can first surface (after the live pipeline and the commit
 * replay), and the one that used to read it as an unknown failure: a LOSS to reconcile for, which
 * asks a member to re-send what was never a message. It freezes the group instead, marks the row
 * seen so the walk stops re-offering it, and reports no loss.
 */
vi.mock('$lib/utils/chat/historyReconcile', () => ({
  escalateReconciliation: vi.fn().mockResolvedValue(true),
}));

import { escalateReconciliation } from '$lib/utils/chat/historyReconcile';
import { createMlsServiceStub } from '$lib/mls-client/test/fixtures/mlsServiceStub';
import { toBase64 } from '$lib/utils/hex';
import { replayConversationHistory, resetSeenCipherCacheForTests } from './history';
import {
  isFrozenByAdmissionRefusal,
  resetAdmissionFreezes,
  setAdmissionFreezeListener,
} from './admissionFreeze';

const USER = 'user-1';
const GROUP = 'group-1';
const wire = new Uint8Array([0x11, 0x22, 0x33, 0x44, 0x55]);
const row = {
  id: '1786655250946-0',
  sender_id: 'peer',
  content: toBase64(wire),
  timestamp: String(1786655250946),
};

const replay = (error: string) => {
  const mlsService = createMlsServiceStub({
    getLocalGroups: vi.fn().mockReturnValue([GROUP]),
    createDecryptSession: vi.fn().mockResolvedValue({
      decryptPage: vi.fn().mockResolvedValue([{ ok: false, error }]),
      finish: vi.fn().mockResolvedValue(undefined),
    }),
    fetchHistory: vi.fn().mockResolvedValue({ rows: [] }),
  });
  return replayConversationHistory({
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
    primedFirstPage: { rows: [row] },
  });
};

beforeEach(() => {
  localStorage.clear();
  resetSeenCipherCacheForTests();
  resetAdmissionFreezes();
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('replayConversationHistory - a refused admission', () => {
  it('freezes the group and tells the listener, once', async () => {
    const listener = vi.fn();
    setAdmissionFreezeListener(listener);

    await replay('ADMISSION_REFUSED: mallory:dev1 entered by external commit');

    expect(isFrozenByAdmissionRefusal(GROUP)).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ groupId: GROUP, entrant: 'mallory:dev1' })
    );
  });

  it('asks nobody to re-send it: a refused commit is not a lost message', async () => {
    await replay('ADMISSION_REFUSED: mallory:dev1 entered by external commit');

    expect(escalateReconciliation).not.toHaveBeenCalled();
  });

  it('control: an unrecognised failure on the same row does not freeze the group', async () => {
    // Without this the case above would pass on a replay that freezes on any failure.
    await replay('something nobody classified');

    expect(isFrozenByAdmissionRefusal(GROUP)).toBe(false);
  });
});
