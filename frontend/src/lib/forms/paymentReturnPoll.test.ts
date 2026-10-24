import { describe, expect, it, vi } from 'vitest';
import { pollPaymentReturn, RETURN_MAX_POLLS, RETURN_POLL_INTERVAL_MS } from './paymentReturnPoll';
import type { PaymentRequestState } from './paymentReturn';

/** The one poll both payment return pages run (member by submission, guest by receipt). */
type Answer = { paymentStatus: string; requestState?: PaymentRequestState };
const reads = (...answers: Answer[]) => {
  const read = vi.fn<() => Promise<Answer>>();
  for (const a of answers) read.mockResolvedValueOnce(a);
  return read;
};
const noSleep = vi.fn(async () => {});

describe('pollPaymentReturn', () => {
  it('stops on the first final answer, and hands every answer to the page', async () => {
    const read = reads({ paymentStatus: 'pending' }, { paymentStatus: 'paid' });
    const seen: string[] = [];
    await expect(pollPaymentReturn(read, (a) => seen.push(a.paymentStatus), noSleep)).resolves.toBe(
      'confirmed'
    );
    expect(read).toHaveBeenCalledTimes(2);
    expect(seen).toEqual(['pending', 'paid']);
    expect(noSleep).toHaveBeenCalledWith(RETURN_POLL_INTERVAL_MS);
  });

  it.each([
    [{ paymentStatus: 'paid_over_capacity' }, 'overCapacity'],
    [{ paymentStatus: 'cancelled', requestState: 'declined' as const }, 'declined'],
    [{ paymentStatus: 'cancelled', requestState: 'cancelled-or-expired' as const }, 'ended'],
    [{ paymentStatus: 'cancelled' }, 'error'],
  ])('ends %o on %s', async (answer, outcome) => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    await expect(pollPaymentReturn(reads(answer), undefined, noSleep)).resolves.toBe(outcome);
  });

  it('says "pending" after its ceiling of reads, never loops on', async () => {
    const read = vi.fn(async () => ({ paymentStatus: 'pending' }));
    await expect(pollPaymentReturn(read, undefined, noSleep)).resolves.toBe('pending');
    expect(read).toHaveBeenCalledTimes(RETURN_MAX_POLLS);
  });

  it('lets a failed read reach the page, which words it', async () => {
    const read = vi.fn(async () => {
      throw new Error('429');
    });
    await expect(pollPaymentReturn(read, undefined, noSleep)).rejects.toThrow('429');
  });
});
