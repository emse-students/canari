import {
  CORE_ERASURE_STATEMENTS,
  ERASURE_TARGETS,
  afterSuccess,
  describeFailure,
  retryDelayMs,
  subjectDigest,
} from './erasure-policy';

describe('erasure policy', () => {
  it('reaches the three services that hold account data, each by its internal DELETE', () => {
    expect(ERASURE_TARGETS.map((t) => t.service)).toEqual(['chat-delivery', 'social', 'media']);
    const urls = ERASURE_TARGETS.map((t) => t.url('u/1'));
    expect(urls[0]).toMatch(/\/api\/internal\/users\/u%2F1$/);
    expect(urls[1]).toMatch(/\/api\/internal\/users\/u%2F1$/);
    expect(urls[2]).toMatch(/\/api\/media\/internal\/users\/u%2F1$/);
  });

  it('backs off from 30 s, doubling, and never waits more than 6 h', () => {
    expect(retryDelayMs(1)).toBe(30_000);
    expect(retryDelayMs(2)).toBe(60_000);
    expect(retryDelayMs(5)).toBe(480_000);
    expect(retryDelayMs(40)).toBe(6 * 60 * 60 * 1000);
  });

  it('completes only a call that STARTED once every token of the account had expired', () => {
    const expiry = new Date('2026-10-16T12:00:00Z');
    expect(afterSuccess(new Date('2026-10-16T11:00:00Z'), expiry)).toEqual({
      kind: 'final-pass',
      at: expiry,
    });
    expect(afterSuccess(expiry, expiry)).toEqual({ kind: 'complete' });
    expect(afterSuccess(new Date('2026-10-17T00:00:00Z'), expiry)).toEqual({ kind: 'complete' });
  });

  it('journals a completed subject as a digest, never the id', () => {
    const d = subjectDigest('the-subject');
    expect(d).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(d).not.toContain('the-subject');
    expect(subjectDigest('the-subject')).toBe(d);
  });

  it('records a failure as a status or a code, never a URL', () => {
    expect(
      describeFailure({ response: { status: 503 }, message: 'http://x/api/internal/users/u1' })
    ).toBe('HTTP 503');
    expect(describeFailure({ code: 'ECONNREFUSED', message: 'connect 10.0.0.1' })).toBe(
      'ECONNREFUSED'
    );
    expect(describeFailure(new TypeError('boom'))).toBe('TypeError');
  });

  it('binds a replacement only to the statements that name $2', () => {
    for (const s of CORE_ERASURE_STATEMENTS) {
      expect(s.sql.includes('$2')).toBe(s.replacement !== undefined);
    }
  });

  it('erases the profile trail with the account (decision 2026-10-16)', () => {
    const sql = CORE_ERASURE_STATEMENTS.map((s) => s.sql).join('\n');
    expect(sql).toContain('DELETE FROM profile_changes WHERE "userId" = $1');
    expect(sql).toContain('DELETE FROM profile_correction_requests WHERE "userId" = $1');
    expect(sql).toContain('DELETE FROM auth_sessions WHERE "userId" = $1');
  });
});
