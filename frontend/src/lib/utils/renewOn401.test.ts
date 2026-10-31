/**
 * THE ONE 401 RULE: only a request that CARRIED a bearer is renewed, the resend replaces the bearer
 * and nothing else, the renewal is bounded by the request's own deadline, a token another caller
 * already renewed is used rather than rotated again, and every 401 body is released.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renewingOn401, sendRenewingOn401, type RenewOn401Options } from './renewOn401';
import { trackedFetch } from './trackedFetch';
import { RequestDeadlineError } from './requestDeadline';
import { TransportFailureError } from './transportFailure';

class RefusedRenewed extends Error {
  constructor() {
    super('refused renewed');
    this.name = 'RefusedRenewed';
  }
}

const reply = (status: number) => new Response('{}', { status });

function opts(
  over: Partial<RenewOn401Options<Response>> = {}
): RenewOn401Options<Response> & { renew: ReturnType<typeof vi.fn> } {
  return {
    tokenNow: async () => 'old',
    renew: vi.fn().mockResolvedValue('new'),
    refusedRenewed: () => new RefusedRenewed(),
    where: 'POST /x',
    ...over,
  } as RenewOn401Options<Response> & { renew: ReturnType<typeof vi.fn> };
}

const decorated = (f: ReturnType<typeof vi.fn>, o = opts()) =>
  renewingOn401(f as unknown as typeof fetch, {
    tokenNow: o.tokenNow,
    renew: o.renew,
    refusedRenewed: () => new RefusedRenewed(),
  });

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('renewingOn401', () => {
  it('passes a request with no bearer through, its 401 being the answer', async () => {
    const f = vi.fn().mockResolvedValue(reply(401));
    const o = opts();
    const res = await decorated(f, o)('https://x.test/a', { method: 'POST', body: 'b' });
    expect(res.status).toBe(401);
    expect(o.renew).not.toHaveBeenCalled();
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('sends the first attempt untouched and replaces only the bearer on the resend', async () => {
    const f = vi.fn().mockResolvedValueOnce(reply(401)).mockResolvedValueOnce(reply(200));
    const signal = new AbortController().signal;
    const init: RequestInit = {
      method: 'POST',
      headers: { Authorization: 'Bearer old', 'X-Canari-Device': 'd1' },
      body: 'same',
      signal,
    };
    const res = await decorated(f)('https://x.test/a', init);
    expect(res.status).toBe(200);
    expect(f.mock.calls[0][1]).toBe(init);
    const resent = f.mock.calls[1][1] as RequestInit;
    const headers = new Headers(resent.headers);
    expect(headers.get('Authorization')).toBe('Bearer new');
    expect(headers.get('X-Canari-Device')).toBe('d1');
    expect(resent.body).toBe('same');
    expect(resent.signal).toBe(signal);
  });
});

describe('sendRenewingOn401', () => {
  it('throws what the caller says a refused renewed token is, after two requests', async () => {
    const send = vi.fn().mockResolvedValue(reply(401));
    await expect(sendRenewingOn401(send, 'old', opts())).rejects.toBeInstanceOf(RefusedRenewed);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('uses a token another caller renewed meanwhile, and renews nothing', async () => {
    const send = vi.fn().mockResolvedValueOnce(reply(401)).mockResolvedValueOnce(reply(200));
    const o = opts({ tokenNow: async () => 'renewed-elsewhere' });
    await sendRenewingOn401(send, 'old', o);
    expect(o.renew).not.toHaveBeenCalled();
    expect(send.mock.calls.map((c) => c[0])).toEqual(['old', 'renewed-elsewhere']);
  });

  it('releases the body of each 401 it does not hand back', async () => {
    const first = reply(401);
    const second = reply(401);
    const send = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const cancels = [vi.spyOn(first.body!, 'cancel'), vi.spyOn(second.body!, 'cancel')];
    await sendRenewingOn401(send, 'old', opts()).catch(() => {});
    for (const c of cancels) expect(c).toHaveBeenCalledTimes(1);
  });

  it('rethrows a renewal failure that settles in time AS IT CAME', async () => {
    const failure = new TransportFailureError(new TypeError('Failed to fetch'));
    const send = vi.fn().mockResolvedValue(reply(401));
    const err = await sendRenewingOn401(send, 'old', {
      ...opts(),
      renew: vi.fn().mockRejectedValue(failure),
      signal: new AbortController().signal,
    }).catch((e: unknown) => e);
    expect(err).toBe(failure);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('the renewal is bounded by the request it serves', () => {
  afterEach(() => vi.useRealTimers());

  it('a renewal slower than the deadline ends the request AT the deadline, as a deadline', async () => {
    vi.useFakeTimers();
    const f = vi.fn().mockResolvedValue(reply(401));
    let renewalSettled = false;
    const renew = vi.fn(
      () =>
        new Promise<string>((resolve) =>
          setTimeout(() => {
            renewalSettled = true;
            resolve('new');
          }, 60_000)
        )
    );
    const fetchImpl = renewingOn401(f as unknown as typeof fetch, {
      tokenNow: async () => 'old',
      renew,
      refusedRenewed: () => new RefusedRenewed(),
    });
    const outcome = trackedFetch(
      fetchImpl,
      'https://x.test/api/mls/commit',
      { method: 'POST', headers: { Authorization: 'Bearer old' }, body: 'x' },
      { deadlineMs: 1_000 }
    ).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1_000);
    const err = await outcome;
    expect(err).toBeInstanceOf(RequestDeadlineError);
    expect(renewalSettled).toBe(false);
    // Nothing was resent once the deadline had passed - not even when the renewal later settles.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('a renewal failure inside the deadline is not retyped as a deadline', async () => {
    const failure = new TransportFailureError(new TypeError('Failed to fetch'));
    const f = vi.fn().mockResolvedValue(reply(401));
    const fetchImpl = renewingOn401(f as unknown as typeof fetch, {
      tokenNow: async () => 'old',
      renew: vi.fn().mockRejectedValue(failure),
      refusedRenewed: () => new RefusedRenewed(),
    });
    const err = await trackedFetch(
      fetchImpl,
      'https://x.test/api/mls/commit',
      { method: 'POST', headers: { Authorization: 'Bearer old' }, body: 'x' },
      { deadlineMs: 1_000 }
    ).catch((e: unknown) => e);
    expect(err).toBe(failure);
  });
});
