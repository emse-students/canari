import { Logger } from '@nestjs/common';
import { checkSafeBrowsing, takeSafeBrowsingRefusalCount } from './safe-browsing';

/** Builds a minimal fetch Response-like object, matching what `checkSafeBrowsing` reads. */
function fakeResponse(ok: boolean, status: number, body: unknown): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as Response;
}

describe('checkSafeBrowsing', () => {
  const originalKey = process.env.GOOGLE_SAFE_BROWSING_API_KEY;

  beforeEach(() => {
    takeSafeBrowsingRefusalCount();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalKey === undefined) {
      delete process.env.GOOGLE_SAFE_BROWSING_API_KEY;
    } else {
      process.env.GOOGLE_SAFE_BROWSING_API_KEY = originalKey;
    }
  });

  it('fails open when no API key is configured', async () => {
    delete process.env.GOOGLE_SAFE_BROWSING_API_KEY;
    const fetchSpy = jest.spyOn(global, 'fetch');

    const verdict = await checkSafeBrowsing('https://example.com');

    expect(verdict.flagged).toBe(false);
    expect(verdict.kind).toBe('unconfigured');
    // No key means no lookup at all - the quota is never spent on a call that cannot answer.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reports clean when the API returns no matches', async () => {
    process.env.GOOGLE_SAFE_BROWSING_API_KEY = 'test-key';
    jest.spyOn(global, 'fetch').mockResolvedValue(fakeResponse(true, 200, {}));

    const verdict = await checkSafeBrowsing('https://example.com');

    expect(verdict.flagged).toBe(false);
    expect(verdict.kind).toBe('answered');
    expect(verdict.cacheTtlMs).toBeGreaterThan(0);
  });

  it('reports flagged when the API returns a match, using its cacheDuration', async () => {
    process.env.GOOGLE_SAFE_BROWSING_API_KEY = 'test-key';
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(fakeResponse(true, 200, { matches: [{ cacheDuration: '120s' }] }));

    const verdict = await checkSafeBrowsing('https://evil.example.com');

    expect(verdict.flagged).toBe(true);
    expect(verdict.kind).toBe('answered');
    expect(verdict.cacheTtlMs).toBe(120_000);
  });

  it('uses the longest cacheDuration when several matches disagree', async () => {
    process.env.GOOGLE_SAFE_BROWSING_API_KEY = 'test-key';
    jest.spyOn(global, 'fetch').mockResolvedValue(
      fakeResponse(true, 200, {
        matches: [{ cacheDuration: '60s' }, { cacheDuration: '600s' }],
      })
    );

    const verdict = await checkSafeBrowsing('https://evil.example.com');

    expect(verdict.flagged).toBe(true);
    expect(verdict.cacheTtlMs).toBe(600_000);
  });

  it('defaults a match with no cacheDuration to 300s', async () => {
    process.env.GOOGLE_SAFE_BROWSING_API_KEY = 'test-key';
    jest.spyOn(global, 'fetch').mockResolvedValue(fakeResponse(true, 200, { matches: [{}] }));

    const verdict = await checkSafeBrowsing('https://evil.example.com');

    expect(verdict.flagged).toBe(true);
    expect(verdict.cacheTtlMs).toBe(300_000);
  });

  it('classifies a 403 as a refusal, logs the Google error at ERROR without the key, and counts it', async () => {
    process.env.GOOGLE_SAFE_BROWSING_API_KEY = 'secret-test-key';
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(global, 'fetch').mockResolvedValue(
      fakeResponse(false, 403, {
        error: { code: 403, status: 'PERMISSION_DENIED', message: 'API not enabled' },
      })
    );

    const verdict = await checkSafeBrowsing('https://example.com');

    expect(verdict).toEqual({ flagged: false, cacheTtlMs: 60 * 60 * 1000, kind: 'refused' });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const line = String(errorSpy.mock.calls[0][0]);
    expect(line).toContain('PERMISSION_DENIED');
    expect(line).toContain('API not enabled');
    expect(line).not.toContain('secret-test-key');
    expect(warnSpy).not.toHaveBeenCalled();
    expect(takeSafeBrowsingRefusalCount()).toBe(1);
    expect(takeSafeBrowsingRefusalCount()).toBe(0);
  });

  it('treats a 400 as ambiguous: ERROR, transient TTL, not counted, even without a JSON body', async () => {
    process.env.GOOGLE_SAFE_BROWSING_API_KEY = 'test-key';
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const res = fakeResponse(false, 400, null);
    res.json = async () => {
      throw new Error('not json');
    };
    jest.spyOn(global, 'fetch').mockResolvedValue(res);

    const verdict = await checkSafeBrowsing('https://example.com');

    expect(verdict.kind).toBe('unavailable');
    expect(verdict.flagged).toBe(false);
    expect(verdict.cacheTtlMs).toBe(5 * 60 * 1000);
    expect(String(errorSpy.mock.calls[0][0])).toContain('http=400');
    expect(takeSafeBrowsingRefusalCount()).toBe(0);
  });

  it('classifies a 401 as a refusal and counts it', async () => {
    process.env.GOOGLE_SAFE_BROWSING_API_KEY = 'test-key';
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        fakeResponse(false, 401, { error: { status: 'UNAUTHENTICATED', message: 'bad key' } })
      );

    const verdict = await checkSafeBrowsing('https://example.com');

    expect(verdict.kind).toBe('refused');
    expect(verdict.cacheTtlMs).toBe(60 * 60 * 1000);
    expect(takeSafeBrowsingRefusalCount()).toBe(1);
  });

  it('keeps a 429 (quota) transient: warn, not counted', async () => {
    process.env.GOOGLE_SAFE_BROWSING_API_KEY = 'test-key';
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(global, 'fetch').mockResolvedValue(fakeResponse(false, 429, {}));

    const verdict = await checkSafeBrowsing('https://example.com');

    expect(verdict.kind).toBe('unavailable');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(takeSafeBrowsingRefusalCount()).toBe(0);
  });

  it('keeps a 5xx transient: warn, short TTL, not counted', async () => {
    process.env.GOOGLE_SAFE_BROWSING_API_KEY = 'test-key';
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(global, 'fetch').mockResolvedValue(fakeResponse(false, 503, {}));

    const verdict = await checkSafeBrowsing('https://example.com');

    expect(verdict).toEqual({ flagged: false, cacheTtlMs: 5 * 60 * 1000, kind: 'unavailable' });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(takeSafeBrowsingRefusalCount()).toBe(0);
  });

  it('fails open when the request throws (network error, timeout)', async () => {
    process.env.GOOGLE_SAFE_BROWSING_API_KEY = 'test-key';
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('network down'));

    const verdict = await checkSafeBrowsing('https://example.com');

    expect(verdict.flagged).toBe(false);
    expect(verdict.kind).toBe('unavailable');
    expect(takeSafeBrowsingRefusalCount()).toBe(0);
  });
});
