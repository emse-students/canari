import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiRefusalError } from '$lib/utils/apiRefusalError';
import {
  createPaymentReader,
  isConfirmUnreadableHere,
  paymentReturnSubmissionId,
  readPaymentReturnOnce,
  watchReturnsToApp,
} from './checkoutReturn';
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

describe('createPaymentReader', () => {
  it('reads once at a time: a second ask while one is in flight answers null, asks nothing', async () => {
    let answer!: (a: Answer) => void;
    const read = vi.fn(() => new Promise<Answer>((done) => (answer = done)));
    const reader = createPaymentReader(read);
    const first = reader.readOnce();
    await expect(reader.readOnce()).resolves.toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
    answer({ paymentStatus: 'paid' });
    await expect(first).resolves.toBe('confirmed');
    // Free again once the read has answered.
    read.mockResolvedValueOnce({ paymentStatus: 'pending' });
    await expect(reader.readOnce()).resolves.toBe('pending');
  });

  it('frees itself after a failed read, which it throws', async () => {
    const read = vi
      .fn<() => Promise<Answer>>()
      .mockRejectedValueOnce(new TypeError('network'))
      .mockResolvedValueOnce({ paymentStatus: 'paid' });
    const reader = createPaymentReader(read);
    await expect(reader.readOnce()).rejects.toBeInstanceOf(TypeError);
    await expect(reader.readOnce()).resolves.toBe('confirmed');
  });
});

describe('watchReturnsToApp', () => {
  it('calls back on each return to the screen, never on leaving it, until unsubscribed', () => {
    const s = screen();
    const onReturn = vi.fn();
    const stop = watchReturnsToApp(onReturn, s.subscribe);
    s.edge(false);
    expect(onReturn).not.toHaveBeenCalled();
    s.edge(true);
    s.edge(false);
    s.edge(true);
    expect(onReturn).toHaveBeenCalledTimes(2);
    stop();
    expect(s.off).toHaveBeenCalledTimes(1);
    s.edge(true);
    expect(onReturn).toHaveBeenCalledTimes(2);
  });
});

describe('paymentReturnSubmissionId', () => {
  it.each([
    ['/forms/success?submission_id=s1', 's1'],
    ['/forms/success/?submission_id=s1&transaction=AB', 's1'],
    ['/forms/success', null],
    ['/forms/successor?submission_id=s1', null],
    ['/forms/f1', null],
    ['', null],
  ])('reads %s as %s', (returnTo, id) => {
    expect(paymentReturnSubmissionId(returnTo)).toBe(id);
  });
});

describe('isConfirmUnreadableHere', () => {
  it.each([
    [401, true],
    [403, true],
    [404, false],
    [429, false],
  ])('status %i -> %s', (status, unreadable) => {
    expect(isConfirmUnreadableHere(new ApiRefusalError(status, null, 'x'))).toBe(unreadable);
  });

  it('a transport failure is not a refusal', () => {
    expect(isConfirmUnreadableHere(new TypeError('network'))).toBe(false);
  });
});
