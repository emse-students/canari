import { afterEach, describe, expect, it, vi } from 'vitest';
import { Log } from '$lib/utils/Log';
import { resetFollowState, retryFailedFollowReads } from './followState.svelte';

describe('retryFailedFollowReads', () => {
  afterEach(() => {
    resetFollowState();
    vi.restoreAllMocks();
  });

  it('does nothing and says nothing when no read failed', () => {
    const debug = vi.spyOn(Log, 'd').mockImplementation(() => {});
    resetFollowState();

    retryFailedFollowReads();

    expect(debug).not.toHaveBeenCalled();
  });
});
