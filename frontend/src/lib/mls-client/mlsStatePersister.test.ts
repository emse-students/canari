import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMlsStatePersister } from './mlsStatePersister';

vi.mock('$lib/utils/hex', () => ({
  saveMlsState: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('$lib/utils/scheduling/yieldToMainThread', () => ({
  yieldToMainThread: vi.fn().mockResolvedValue(undefined),
}));

import { saveMlsState } from '$lib/utils/hex';

describe('createMlsStatePersister', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(saveMlsState).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makePersister() {
    const saveState = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]));
    const persister = createMlsStatePersister({
      mlsService: { saveState } as any,
      pin: '1234',
      userId: 'user-1',
      deferredMs: 5_000,
    });
    return { saveState, persister };
  }

  it('debounces application-message persistence', async () => {
    const { saveState, persister } = makePersister();
    persister.scheduleDeferred();
    persister.scheduleDeferred();
    expect(saveState).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(saveState).toHaveBeenCalledTimes(1);
    expect(saveMlsState).toHaveBeenCalledWith('user-1', new Uint8Array([1, 2, 3]));
  });

  it('coalesces persistNow calls in the same tick', async () => {
    const { saveState, persister } = makePersister();
    persister.persistNow();
    persister.persistNow();
    await Promise.resolve();
    await Promise.resolve();
    expect(saveState).toHaveBeenCalledTimes(1);
  });

  it('defers persistence during bulk ingest and flushes once at end', async () => {
    const { saveState, persister } = makePersister();
    persister.onBulkIngestStart();
    persister.scheduleDeferred();
    persister.persistNow();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(saveState).not.toHaveBeenCalled();

    await persister.onBulkIngestEnd();
    expect(saveState).toHaveBeenCalledTimes(1);
  });
});
