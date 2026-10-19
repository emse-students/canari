/**
 * The D38b routes the inbox and the queue call: the count route and its `{ pending }` body, and the
 * withdrawal, which answers the id and the status only (review of #2116).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const socialRequest = vi.hoisted(() => vi.fn());
vi.mock('$lib/posts/api', () => ({ socialRequest }));

import { countMyRepublicationRequests, withdrawProposal } from './api';

afterEach(() => socialRequest.mockReset());

describe('proposals api', () => {
  it('counts the waiting requests through the count route, never the inbox', async () => {
    socialRequest.mockResolvedValue({ pending: 4 });
    await expect(countMyRepublicationRequests()).resolves.toBe(4);
    expect(socialRequest).toHaveBeenCalledWith('/api/posts/me/republication-requests/count');
  });

  it('withdraws through the generic route and hands back what the server answered', async () => {
    socialRequest.mockResolvedValue({ id: 'p-1', status: 'withdrawn' });
    await expect(withdrawProposal('p-1')).resolves.toEqual({ id: 'p-1', status: 'withdrawn' });
    expect(socialRequest).toHaveBeenCalledWith('/api/associations/proposals/p-1/withdraw', {
      method: 'POST',
    });
  });
});
