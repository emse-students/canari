import { describe, expect, it } from 'vitest';
import { refusalFromResponse } from './apiRefusalError';

/**
 * `refusalFromResponse` TYPES A REFUSAL AT THE THROW, so every field a caller decides on is read
 * once, here, from the body - never re-parsed by the caller and never read out of the message.
 */
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('refusalFromResponse', () => {
  it('carries the code, the reason and the wait a refusal body names', async () => {
    const refusal = await refusalFromResponse(
      json(429, { code: 'RATE_LIMITED', reason: 'per_user', retryAfterMs: 42_000 }),
      'Commit submission HTTP error'
    );

    expect(refusal.status).toBe(429);
    expect(refusal.code).toBe('RATE_LIMITED');
    expect(refusal.reason).toBe('per_user');
    expect(refusal.retryAfterMs).toBe(42_000);
  });

  it('carries none of them when the body names none', async () => {
    const refusal = await refusalFromResponse(json(403, { message: 'no' }), 'x');

    expect(refusal.code).toBeNull();
    expect(refusal.reason).toBeNull();
    expect(refusal.retryAfterMs).toBeNull();
  });

  it('keeps only a finite, non-negative wait', async () => {
    expect((await refusalFromResponse(json(429, { retryAfterMs: -5 }), 'x')).retryAfterMs).toBe(0);
    expect(
      (await refusalFromResponse(json(429, { retryAfterMs: '30' }), 'x')).retryAfterMs
    ).toBeNull();
  });

  it('reads a non-JSON edge page as a status alone, and leaves the body to the caller', async () => {
    const res = new Response('<html>bad gateway</html>', { status: 502 });

    const refusal = await refusalFromResponse(res, 'x');

    expect(refusal.status).toBe(502);
    expect(refusal.code).toBeNull();
    expect(await res.text()).toContain('bad gateway');
  });
});
