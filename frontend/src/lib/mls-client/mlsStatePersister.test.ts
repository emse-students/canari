import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createMlsStatePersister,
  registerMlsStatePersister,
  unregisterMlsStatePersister,
  scheduleOutboundMlsPersist,
} from './mlsStatePersister';

vi.mock('$lib/utils/hex', () => ({
  saveMlsStateEncrypted: vi.fn().mockResolvedValue(undefined),
  saveMlsStatePlain: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('$lib/utils/scheduling/yieldToMainThread', () => ({
  yieldToMainThread: vi.fn().mockResolvedValue(undefined),
}));

import { saveMlsStateEncrypted, saveMlsStatePlain } from '$lib/utils/hex';

describe('createMlsStatePersister', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(saveMlsStateEncrypted).mockClear();
    vi.mocked(saveMlsStatePlain).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    unregisterMlsStatePersister();
  });

  function makePersister() {
    const saveState = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]));
    const saveStatePlain = vi.fn().mockResolvedValue(new Uint8Array([4, 5, 6]));
    const persister = createMlsStatePersister({
      mlsService: { saveState, saveStatePlain } as any,
      pin: '1234',
      userId: 'user-1',
      deferredMs: 5_000,
    });
    return { saveState, saveStatePlain, persister };
  }

  it('debounces application-message persistence to plain CBOR', async () => {
    const { saveState, saveStatePlain, persister } = makePersister();
    persister.scheduleDeferred();
    persister.scheduleDeferred();
    expect(saveState).not.toHaveBeenCalled();
    expect(saveStatePlain).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(saveStatePlain).toHaveBeenCalledTimes(1);
    expect(saveState).not.toHaveBeenCalled();
    expect(saveMlsStatePlain).toHaveBeenCalledWith('user-1', new Uint8Array([4, 5, 6]));
  });

  it('coalesces persistNow calls in the same tick (encrypted)', async () => {
    const { saveState, saveStatePlain, persister } = makePersister();
    persister.persistNow();
    persister.persistNow();
    await persister.flush();
    expect(saveState).toHaveBeenCalledTimes(1);
    expect(saveStatePlain).not.toHaveBeenCalled();
    expect(saveMlsStateEncrypted).toHaveBeenCalledWith('user-1', new Uint8Array([1, 2, 3]));
  });

  it('defers persistence during bulk ingest and flushes encrypted at end', async () => {
    const { saveState, saveStatePlain, persister } = makePersister();
    persister.onBulkIngestStart();
    persister.scheduleDeferred();
    persister.persistNow();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(saveState).not.toHaveBeenCalled();
    expect(saveStatePlain).not.toHaveBeenCalled();

    await persister.onBulkIngestEnd();
    expect(saveState).toHaveBeenCalledTimes(1);
    expect(saveStatePlain).not.toHaveBeenCalled();
  });

  it('scheduleOutboundMlsPersist delegates to the registered persister', async () => {
    const { saveStatePlain, persister } = makePersister();
    registerMlsStatePersister(persister);
    scheduleOutboundMlsPersist();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(saveStatePlain).toHaveBeenCalledTimes(1);
  });

  it('scheduleOutboundMlsPersist is a no-op without a registered persister', () => {
    expect(() => scheduleOutboundMlsPersist()).not.toThrow();
  });
});
