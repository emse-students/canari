import {
  CORE_ERASURE_STATEMENTS,
  ERASURE_TARGETS,
  UNKNOWN_SERVICE,
  afterSuccess,
  classifyFailure,
  describeFailure,
  retryDelayMs,
  subjectDigest,
} from './erasure-policy';

describe('erasure policy', () => {
  it("erases core's own part in-process and reaches the three services by their internal DELETE", () => {
    expect(ERASURE_TARGETS.map((t) => t.service)).toEqual([
      'core',
      'chat-delivery',
      'social',
      'media',
    ]);
    expect(ERASURE_TARGETS[0].kind).toBe('local');
    const urls = ERASURE_TARGETS.flatMap((t) => (t.kind === 'http' ? [t.url('u/1')] : []));
    expect(urls[0]).toMatch(/\/api\/internal\/users\/u%2F1$/);
    expect(urls[1]).toMatch(/\/api\/internal\/users\/u%2F1$/);
    expect(urls[2]).toMatch(/\/api\/media\/internal\/users\/u%2F1$/);
  });

  it('calls a refusal of the request itself permanent, and a service down or busy transient', () => {
    for (const status of [400, 401, 403, 404, 409, 422]) {
      expect(classifyFailure({ response: { status } })).toBe('permanent');
    }
    for (const status of [408, 429, 500, 502, 503]) {
      expect(classifyFailure({ response: { status } })).toBe('transient');
    }
    expect(classifyFailure({ code: 'ECONNREFUSED' })).toBe('transient');
    expect(classifyFailure({ code: UNKNOWN_SERVICE })).toBe('permanent');
    expect(classifyFailure(new Error('database blip'))).toBe('transient');
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
    expect(describeFailure(new TypeError('boom'))).toBe('TypeError: boom');
    // A service's error CODE is kept; anything that is not a bare code is not.
    expect(
      describeFailure({
        response: { status: 409, data: { code: 'ERASURE_WORKSPACE_REPAIR_FAILED' } },
      })
    ).toBe('HTTP 409 ERASURE_WORKSPACE_REPAIR_FAILED');
    expect(describeFailure({ response: { status: 409, data: { code: 'user u1 failed' } } })).toBe(
      'HTTP 409'
    );
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
    // A restore key could otherwise sign the erased account's subject back in (WP-RESTORE-1).
    expect(sql).toContain('DELETE FROM restore_credentials WHERE "userId" = $1');
    expect(CORE_ERASURE_STATEMENTS[CORE_ERASURE_STATEMENTS.length - 1].sql).toBe(
      'DELETE FROM users WHERE id = $1'
    );
  });

  describe('describeFailure fingerprint of a bare driver error', () => {
    it('tells different causes apart and carries no id', () => {
      const a = describeFailure(new Error('Connection terminated unexpectedly'));
      const b = describeFailure(new Error('timeout exceeded when trying to connect'));
      expect(a).not.toEqual(b);
      const withId = describeFailure(
        new Error('duplicate key (subjectId)=(0a0a0a0a0a0a0a0a) 4711')
      );
      expect(withId).not.toMatch(/0a0a0a0a|4711|subjectId/);
    });
  });
});
