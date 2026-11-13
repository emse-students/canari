import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiRefusalError } from '$lib/utils/apiRefusalError';
import { readPaymentOnReturnToApp, readPaymentReturnOnce } from './checkoutReturn';
import type { PaymentRequestState } from './paymentReturn';

type Answer = { paymentStatus: string; requestState?: PaymentRequestState };

/** A fake screen-transition source: the test fires the edges `onAppScreenChange` would. */
function screen() {
  let listener: ((onScreen: boolean) => void) | null = null;
  const off = vi.fn(() => (listener = null));
  return {
    subscribe: (cb: (onScreen: boolean) => void) => {
      listener = cb;
      return off;
    },
    edge: (onScreen: boolean) => listener?.(onScreen),
    off,
  };
}

/** Lets the read's promise chain settle. */
const settle = () => new Promise((done) => setTimeout(done, 0));

afterEach(() => vi.restoreAllMocks());

describe('readPaymentReturnOnce', () => {
  it.each([
    [{ paymentStatus: 'paid' }, 'confirmed'],
    [{ paymentStatus: 'pending' }, 'pending'],
    [{ paymentStatus: 'expired' }, 'pending'],
    [{ paymentStatus: 'paid_over_capacity' }, 'overCapacity'],
    [{ paymentStatus: 'cancelled', requestState: 'declined' as const }, 'declined'],
    [{ paymentStatus: 'cancelled', requestState: 'cancelled-or-expired' as const }, 'ended'],
    [{ paymentStatus: 'cancelled' }, 'error'],
  ])('reads %o once as %s', async (answer: Answer, outcome) => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const read = vi.fn(async () => answer);
    await expect(readPaymentReturnOnce(read)).resolves.toBe(outcome);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('reads the server limit on asking Lydia (429) as pending, not as a failure', async () => {
    const read = vi.fn(async (): Promise<Answer> => {
      throw new ApiRefusalError(429, null, 'throttled');
    });
    await expect(readPaymentReturnOnce(read)).resolves.toBe('pending');
  });

  it('throws any other failure: a failed read decides nothing', async () => {
    const read = vi.fn(async (): Promise<Answer> => {
      throw new ApiRefusalError(500, null, 'boom');
    });
    await expect(readPaymentReturnOnce(read)).rejects.toBeInstanceOf(ApiRefusalError);
  });
});

describe('readPaymentOnReturnToApp', () => {
  it('reads nothing until the app comes back on screen, then once per return', async () => {
    const s = screen();
    const read = vi.fn(async () => ({ paymentStatus: 'pending' }));
    const onOutcome = vi.fn();
    readPaymentOnReturnToApp({ read, onOutcome, subscribe: s.subscribe });
    expect(read).not.toHaveBeenCalled();

    s.edge(false);
    await settle();
    expect(read).not.toHaveBeenCalled();

    s.edge(true);
    await settle();
    expect(read).toHaveBeenCalledTimes(1);
    expect(onOutcome).toHaveBeenLastCalledWith('pending', { paymentStatus: 'pending' });

    s.edge(false);
    s.edge(true);
    await settle();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('does not ask twice while a read is in flight', async () => {
    const s = screen();
    let answer!: (a: Answer) => void;
    const read = vi.fn(() => new Promise<Answer>((done) => (answer = done)));
    const onOutcome = vi.fn();
    readPaymentOnReturnToApp({ read, onOutcome, subscribe: s.subscribe });
    s.edge(true);
    s.edge(true);
    expect(read).toHaveBeenCalledTimes(1);
    answer({ paymentStatus: 'paid' });
    await settle();
    expect(onOutcome).toHaveBeenCalledExactlyOnceWith('confirmed', { paymentStatus: 'paid' });
  });

  it('says nothing to a page that stopped watching, and unsubscribes', async () => {
    const s = screen();
    let answer!: (a: Answer) => void;
    const read = vi.fn(() => new Promise<Answer>((done) => (answer = done)));
    const onOutcome = vi.fn();
    const stop = readPaymentOnReturnToApp({ read, onOutcome, subscribe: s.subscribe });
    s.edge(true);
    stop();
    expect(s.off).toHaveBeenCalledTimes(1);
    answer({ paymentStatus: 'paid' });
    await settle();
    expect(onOutcome).not.toHaveBeenCalled();
  });

  it('keeps pending on a failed read, says it, and asks again on the next return', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = screen();
    const read = vi
      .fn<() => Promise<Answer>>()
      .mockRejectedValueOnce(new TypeError('network'))
      .mockResolvedValueOnce({ paymentStatus: 'paid' });
    const onOutcome = vi.fn();
    readPaymentOnReturnToApp({ read, onOutcome, subscribe: s.subscribe });
    s.edge(true);
    await settle();
    expect(onOutcome).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    s.edge(false);
    s.edge(true);
    await settle();
    expect(onOutcome).toHaveBeenCalledExactlyOnceWith('confirmed', { paymentStatus: 'paid' });
  });
});
