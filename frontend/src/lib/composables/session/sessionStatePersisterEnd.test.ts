/**
 * The end of a session's state persister: its final checkpoint holds the lead, and the persister is
 * gone once that write settled (review of #4053).
 */
const registry = vi.hoisted(() => ({
  active: null as object | null,
  flush: vi.fn(),
  unregister: vi.fn(),
}));
const uninstallLifecycle = vi.hoisted(() => vi.fn());
const disposeWorker = vi.hoisted(() => vi.fn());

vi.mock('$lib/mls-client/mlsStatePersisterRegistry', () => ({
  activeMlsStatePersister: () => registry.active,
  flushActiveMlsStateEncrypted: () => registry.flush(),
  unregisterMlsStatePersister: (p: object | null) => {
    registry.unregister(p);
    if (registry.active === p) registry.active = null;
  },
}));
vi.mock('$lib/mls-client/mlsStatePersisterLifecycle', () => ({
  uninstallMlsStatePersisterLifecycle: uninstallLifecycle,
}));
vi.mock('$lib/mls-client/mlsEncryptWorkerSession', () => ({
  disposeMlsEncryptWorker: disposeWorker,
}));

import { leadHoldsInFlight, resetLeadHoldsForTests } from '$lib/mls-client/leadHolds';
import { endSessionStatePersister, whenEndedSessionStateWritten } from './sessionStatePersisterEnd';

describe('endSessionStatePersister', () => {
  beforeEach(() => {
    resetLeadHoldsForTests();
    vi.clearAllMocks();
  });

  it('holds the lead through the final checkpoint, then removes the persister it ended', async () => {
    const persister = {};
    registry.active = persister;
    let land!: () => void;
    registry.flush.mockImplementation(() => new Promise<void>((r) => (land = r)));

    const ended = endSessionStatePersister(true, () => {});
    // Counted synchronously: a session flag that falls right after the call already sees it.
    expect(leadHoldsInFlight()).toBe(1);
    expect(registry.unregister).not.toHaveBeenCalled();

    land();
    await ended;
    await whenEndedSessionStateWritten();
    expect(leadHoldsInFlight()).toBe(0);
    expect(registry.unregister).toHaveBeenCalledWith(persister);
    expect(uninstallLifecycle).toHaveBeenCalledWith(persister);
    expect(disposeWorker).toHaveBeenCalledTimes(1);
  });

  it('releases the lead and removes the persister when the final write fails, and never rejects', async () => {
    const persister = {};
    registry.active = persister;
    registry.flush.mockRejectedValue(new Error('disk full'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(endSessionStatePersister(true, () => {})).resolves.toBeUndefined();
    expect(leadHoldsInFlight()).toBe(0);
    expect(registry.unregister).toHaveBeenCalledWith(persister);
    expect(error.mock.calls[0]?.[0]).toContain('Final MLS checkpoint failed');
    error.mockRestore();
  });

  it('removes the persister at once, holding nothing, when no final checkpoint is owed', async () => {
    const persister = {};
    registry.active = persister;
    const ended = endSessionStatePersister(false, () => {});
    expect(leadHoldsInFlight()).toBe(0);
    expect(registry.unregister).toHaveBeenCalledWith(persister);
    expect(registry.flush).not.toHaveBeenCalled();
    await ended;
  });

  it('keeps the encrypt worker when a newer session registered its own persister meanwhile', async () => {
    const ended = {};
    registry.active = ended;
    let land!: () => void;
    registry.flush.mockImplementation(() => new Promise<void>((r) => (land = r)));
    const done = endSessionStatePersister(true, () => {});
    const newer = {};
    registry.active = newer;
    land();
    await done;
    expect(registry.unregister).toHaveBeenCalledWith(ended);
    expect(registry.active).toBe(newer);
    expect(disposeWorker).not.toHaveBeenCalled();
  });

  it('a later sign-out waits for the LAST ended session only - never for an older put that hangs', async () => {
    registry.active = {};
    registry.flush.mockImplementationOnce(() => new Promise<void>(() => {}));
    void endSessionStatePersister(true, () => {});
    registry.active = {};
    registry.flush.mockResolvedValueOnce(undefined);
    await endSessionStatePersister(true, () => {});

    await expect(whenEndedSessionStateWritten()).resolves.toBeUndefined();
  });
});
