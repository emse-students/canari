/**
 * THE ONE 401 RULE, as a `fetch` decorator: only a request that CARRIED a bearer is renewed, and the
 * resend replaces the bearer and nothing else.
 */
import { describe, expect, it, vi } from 'vitest';
import { renewingOn401 } from './renewOn401';

const reply = (status: number) => new Response('{}', { status });

describe('renewingOn401', () => {
  it('passes a request with no bearer through, its 401 being the answer', async () => {
    const f = vi.fn().mockResolvedValue(reply(401));
    const renew = vi.fn();
    const res = await renewingOn401(f as unknown as typeof fetch, renew)('https://x.test/a', {
      method: 'POST',
      body: 'b',
    });
    expect(res.status).toBe(401);
    expect(renew).not.toHaveBeenCalled();
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
    const res = await renewingOn401(f as unknown as typeof fetch, async () => 'new')(
      'https://x.test/a',
      init
    );
    expect(res.status).toBe(200);
    expect(f.mock.calls[0][1]).toBe(init);
    const resent = f.mock.calls[1][1] as RequestInit;
    const headers = new Headers(resent.headers);
    expect(headers.get('Authorization')).toBe('Bearer new');
    expect(headers.get('X-Canari-Device')).toBe('d1');
    expect(resent.body).toBe('same');
    // The caller's deadline bounds the resend too.
    expect(resent.signal).toBe(signal);
  });
});
