import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  solicitHistory,
  noteHistoryBundleReceived,
  cancelHistorySolicit,
  cancelAllHistorySolicit,
} from './historySolicit';

const log = () => {};

function makeMls() {
  return { sendHistoryRequest: vi.fn().mockResolvedValue(undefined) };
}

describe('solicitHistory', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cancelAllHistorySolicit();
    vi.useRealTimers();
  });

  it('sends an immediate request, then re-solicits on the bounded backoff', () => {
    const mls = makeMls();
    solicitHistory(mls, 'g1', log, [1000, 2000]);

    // Attempt 0 fires synchronously.
    expect(mls.sendHistoryRequest).toHaveBeenCalledTimes(1);
    expect(mls.sendHistoryRequest).toHaveBeenCalledWith('g1');

    vi.advanceTimersByTime(1000);
    expect(mls.sendHistoryRequest).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(2000);
    expect(mls.sendHistoryRequest).toHaveBeenCalledTimes(3);

    // No further retries beyond the provided delays.
    vi.advanceTimersByTime(10_000);
    expect(mls.sendHistoryRequest).toHaveBeenCalledTimes(3);
  });

  it('stops retrying once a history_bundle is received', () => {
    const mls = makeMls();
    solicitHistory(mls, 'g1', log, [1000, 2000]);
    expect(mls.sendHistoryRequest).toHaveBeenCalledTimes(1);

    noteHistoryBundleReceived('g1');
    vi.advanceTimersByTime(10_000);
    expect(mls.sendHistoryRequest).toHaveBeenCalledTimes(1);
  });

  it('cancelHistorySolicit only affects the named group', () => {
    const mls = makeMls();
    solicitHistory(mls, 'g1', log, [1000]);
    solicitHistory(mls, 'g2', log, [1000]);
    expect(mls.sendHistoryRequest).toHaveBeenCalledTimes(2);

    cancelHistorySolicit('g1');
    vi.advanceTimersByTime(1000);
    // Only g2's retry fires.
    expect(mls.sendHistoryRequest).toHaveBeenCalledTimes(3);
    expect(mls.sendHistoryRequest).toHaveBeenLastCalledWith('g2');
  });

  it('re-soliciting the same group restarts cleanly without duplicating timers', () => {
    const mls = makeMls();
    solicitHistory(mls, 'g1', log, [1000]);
    solicitHistory(mls, 'g1', log, [1000]);
    // Two immediate fires (one per call), but the first call's timer was cancelled by the second.
    expect(mls.sendHistoryRequest).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(1000);
    // Only the surviving (second) solicitation's single retry fires.
    expect(mls.sendHistoryRequest).toHaveBeenCalledTimes(3);
  });
});
