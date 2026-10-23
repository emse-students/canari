// @vitest-environment happy-dom
/**
 * SALON WRITES OWED TO THE RECONNECT (WP-OFF-3, WP-OFF-4): the reconnect is the only trigger, a later
 * write under the same key replaces the owed one, and a write delivered once is never delivered twice.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TransportFailureError } from '$lib/utils/transportFailure';
import { connectivity } from '$lib/stores/connectivity.svelte';
import { ChannelApiError } from '$lib/services/ChannelService';
import { GraineSealUnavailableError } from '$lib/utils/graine/sealUnavailable';
import { RequestDeadlineError } from '$lib/utils/requestDeadline';
import {
  deliverSalonWrite,
  isSalonWriteOwed,
  nothingLeftTheDevice,
  oweSalonWrite,
  resetOwedSalonWrites,
  type SalonWriteOutcome,
} from './salonOwed';

beforeEach(() => {
  connectivity.reset();
  resetOwedSalonWrites();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});

afterEach(() => {
  connectivity.reset();
  vi.restoreAllMocks();
});

describe('the owed salon writes', () => {
  it('runs nothing until the reconnect, then each write once', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    connectivity.notifyServerUnreachable();
    oweSalonWrite('pin:m1', write);
    expect(write).not.toHaveBeenCalled();

    connectivity.notifyServerReachable();
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));

    // A second reconnect finds nothing left to send.
    connectivity.notifyServerUnreachable();
    connectivity.notifyServerReachable();
    await Promise.resolve();
    expect(write).toHaveBeenCalledTimes(1);
    expect(isSalonWriteOwed('pin:m1')).toBe(false);
  });

  it('a later write under the same key replaces the owed one', async () => {
    const first = vi.fn().mockResolvedValue(undefined);
    const later = vi.fn().mockResolvedValue(undefined);
    connectivity.notifyServerUnreachable();
    oweSalonWrite('vote:p1', first);
    oweSalonWrite('vote:p1', later);

    connectivity.notifyServerReachable();
    await vi.waitFor(() => expect(later).toHaveBeenCalledTimes(1));
    expect(first).not.toHaveBeenCalled();
  });

  it('one write throwing never stops the others', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = vi.fn().mockRejectedValue(new Error('bug'));
    const fine = vi.fn().mockResolvedValue(undefined);
    connectivity.notifyServerUnreachable();
    oweSalonWrite('a', broken);
    oweSalonWrite('b', fine);

    connectivity.notifyServerReachable();
    await vi.waitFor(() => expect(fine).toHaveBeenCalledTimes(1));
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('owed write a threw'),
      expect.any(Error)
    );
  });
});

describe('deliverSalonWrite', () => {
  const run = async (attempt: () => Promise<void>) => {
    const outcomes: SalonWriteOutcome['kind'][] = [];
    await deliverSalonWrite('k', attempt, (o) => outcomes.push(o.kind));
    return outcomes;
  };

  it('does not even try while offline, and settles once delivered on the reconnect', async () => {
    connectivity.notifyServerUnreachable();
    const attempt = vi.fn().mockResolvedValue(undefined);
    const outcomes: SalonWriteOutcome['kind'][] = [];
    await deliverSalonWrite('k', attempt, (o) => outcomes.push(o.kind));
    expect(attempt).not.toHaveBeenCalled();
    expect(outcomes).toEqual(['owed']);

    connectivity.notifyServerReachable();
    await vi.waitFor(() => expect(outcomes).toEqual(['owed', 'sent']));
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('owes a write whose failure took the link down, and fails one that left it up', async () => {
    expect(
      await run(() => {
        connectivity.notifyServerUnreachable();
        return Promise.reject(new TransportFailureError(new TypeError('Failed to fetch')));
      })
    ).toEqual(['owed']);
    connectivity.reset();
    expect(
      await run(() => Promise.reject(new TransportFailureError(new TypeError('Failed to fetch'))))
    ).toEqual(['failed']);
  });
});

describe('nothingLeftTheDevice', () => {
  it('is true only where nothing can have been stored', () => {
    expect(nothingLeftTheDevice(new ChannelApiError(403, null, 'no'))).toBe(true);
    expect(nothingLeftTheDevice(new GraineSealUnavailableError('no seal', 'no-session'))).toBe(
      true
    );
    // A 5xx may come from a proxy AFTER the write was stored; an untyped throw proves nothing.
    expect(nothingLeftTheDevice(new ChannelApiError(502, null, 'gateway'))).toBe(false);
    expect(nothingLeftTheDevice(new Error('who knows'))).toBe(false);
  });

  it('is false for no answer with the link up: the outcome is unknown, the server may hold it', () => {
    expect(nothingLeftTheDevice(new TransportFailureError(new TypeError('Failed to fetch')))).toBe(
      false
    );
    expect(nothingLeftTheDevice(new RequestDeadlineError('api' as never, 1, 'POST', '/x', 0))).toBe(
      false
    );
  });
});
