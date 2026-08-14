import { createMlsStatePersister } from './mlsStatePersister';
import {
  registerMlsStatePersister,
  unregisterMlsStatePersister,
  scheduleOutboundMlsPersist,
  persistMlsStructuralCheckpoint,
} from './mlsStatePersisterRegistry';

vi.mock('$lib/utils/hex', () => ({
  saveMlsStateEncrypted: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('$lib/utils/scheduling/yieldToMainThread', () => ({
  yieldToMainThread: vi.fn().mockResolvedValue(undefined),
}));

import { saveMlsStateEncrypted } from '$lib/utils/hex';

describe('createMlsStatePersister', () => {
  beforeEach(() => {
    vi.mocked(saveMlsStateEncrypted).mockClear();
  });

  afterEach(() => {
    unregisterMlsStatePersister();
  });

  function makePersister() {
    const saveState = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]));
    const persister = createMlsStatePersister({
      mlsService: { saveState } as any,
      deviceKeyB64: '1234',
      userId: 'user-1',
    });
    return { saveState, persister };
  }

  it('scheduleDeferred marks dirty without writing to disk', async () => {
    const { saveState, persister } = makePersister();
    persister.scheduleDeferred();
    persister.scheduleDeferred();
    await new Promise((r) => setTimeout(r, 50));
    expect(saveState).not.toHaveBeenCalled();
    expect(saveMlsStateEncrypted).not.toHaveBeenCalled();
  });

  it('coalesces persistNow calls in the same tick (encrypted)', async () => {
    const { saveState, persister } = makePersister();
    persister.persistNow();
    persister.persistNow();
    await persister.flush();
    expect(saveState).toHaveBeenCalledTimes(1);
    expect(saveMlsStateEncrypted).toHaveBeenCalledWith('user-1', new Uint8Array([1, 2, 3]));
  });

  it('defers disk writes during bulk ingest and flushes encrypted at end', async () => {
    const { saveState, persister } = makePersister();
    persister.onBulkIngestStart();
    persister.scheduleDeferred();
    persister.persistNow();
    await new Promise((r) => setTimeout(r, 50));
    expect(saveState).not.toHaveBeenCalled();

    await persister.onBulkIngestEnd();
    expect(saveState).toHaveBeenCalledTimes(1);
  });

  it('closes the ingest window WITHOUT waiting for the checkpoint - durability must not gate delivery', async () => {
    // The pipeline awaits every bulk-ingest observer, so a checkpoint awaited here is a checkpoint
    // charged to the next message's latency: measured at 8.0 s on a cold web client and 3.2 s on the
    // phone, with the frame already received and sitting undecrypted behind it.
    let release: () => void = () => {};
    const saveState = vi
      .fn()
      .mockImplementation(() => new Promise((r) => (release = () => r(new Uint8Array([1, 2, 3])))));
    const persister = createMlsStatePersister({
      mlsService: { saveState } as any,
      deviceKeyB64: '1234',
      userId: 'user-1',
    });

    persister.onBulkIngestStart();
    persister.persistNow();

    let ended = false;
    void persister.onBulkIngestEnd().then(() => (ended = true));
    await new Promise((r) => setTimeout(r, 50));

    // The window is closed while the disk write is still in flight - that is the whole point.
    expect(ended).toBe(true);
    expect(saveState).toHaveBeenCalledTimes(1);
    expect(saveMlsStateEncrypted).not.toHaveBeenCalled();

    release();
    await new Promise((r) => setTimeout(r, 50));
    expect(saveMlsStateEncrypted).toHaveBeenCalledTimes(1);
  });

  it('a checkpoint that FAILS after the window closed does not reject into the pipeline', async () => {
    // Unawaited work still has to be caught: an unhandled rejection reaching the window would take
    // down the very pipeline this change decoupled.
    const saveState = vi.fn().mockRejectedValue(new Error('disk gone'));
    const persister = createMlsStatePersister({
      mlsService: { saveState } as any,
      deviceKeyB64: '1234',
      userId: 'user-1',
    });

    persister.onBulkIngestStart();
    persister.persistNow();
    await expect(persister.onBulkIngestEnd()).resolves.toBeUndefined();
    await new Promise((r) => setTimeout(r, 50));
  });

  it('scheduleOutboundMlsPersist checkpoints to disk - a rewound ratchet loses the next message', async () => {
    const { saveState, persister } = makePersister();
    registerMlsStatePersister(persister);
    scheduleOutboundMlsPersist();
    await new Promise((r) => setTimeout(r, 50));
    expect(saveState).toHaveBeenCalledTimes(1);
  });

  it('coalesces a burst of outbound sends into one checkpoint', async () => {
    const { saveState, persister } = makePersister();
    registerMlsStatePersister(persister);
    scheduleOutboundMlsPersist();
    scheduleOutboundMlsPersist();
    scheduleOutboundMlsPersist();
    await new Promise((r) => setTimeout(r, 50));
    expect(saveState).toHaveBeenCalledTimes(1);
  });

  it('outbound sends during a bulk ingest wait for the ingest to end', async () => {
    const { saveState, persister } = makePersister();
    registerMlsStatePersister(persister);
    persister.onBulkIngestStart();
    scheduleOutboundMlsPersist();
    await new Promise((r) => setTimeout(r, 50));
    expect(saveState).not.toHaveBeenCalled();
    await persister.onBulkIngestEnd();
    expect(saveState).toHaveBeenCalledTimes(1);
  });

  it('flushEncrypted persists after scheduleDeferred marked dirty', async () => {
    const { saveState, persister } = makePersister();
    persister.scheduleDeferred();
    await persister.flushEncrypted();
    expect(saveState).toHaveBeenCalledTimes(1);
  });

  it('scheduleOutboundMlsPersist is a no-op without a registered persister', () => {
    expect(() => scheduleOutboundMlsPersist()).not.toThrow();
  });
});

describe('persistMlsStructuralCheckpoint', () => {
  afterEach(() => {
    unregisterMlsStatePersister();
  });

  it('uses the active persister when registered', async () => {
    const saveState = vi.fn().mockResolvedValue(new Uint8Array([4, 5]));
    const persister = createMlsStatePersister({
      mlsService: { saveState } as any,
      deviceKeyB64: '9999',
      userId: 'user-struct',
    });
    registerMlsStatePersister(persister);

    await persistMlsStructuralCheckpoint();

    expect(saveState).toHaveBeenCalledTimes(1);
  });

  it('falls back to direct save when no persister is registered', async () => {
    const saveState = vi.fn().mockResolvedValue(new Uint8Array([6, 7]));

    await persistMlsStructuralCheckpoint({
      mlsService: { saveState } as any,
      deviceKeyB64: '1111',
      userId: 'fallback-user',
    });

    expect(saveState).toHaveBeenCalledWith('1111');
    expect(saveMlsStateEncrypted).toHaveBeenCalledWith('fallback-user', new Uint8Array([6, 7]));
  });
});
