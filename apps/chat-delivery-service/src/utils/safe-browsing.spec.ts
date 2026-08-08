import { checkSafeBrowsing } from './safe-browsing';

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
    // No key means no lookup at all - the quota is never spent on a call that cannot answer.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reports clean when the API returns no matches', async () => {
    process.env.GOOGLE_SAFE_BROWSING_API_KEY = 'test-key';
    jest.spyOn(global, 'fetch').mockResolvedValue(fakeResponse(true, 200, {}));

    const verdict = await checkSafeBrowsing('https://example.com');

    expect(verdict.flagged).toBe(false);
    expect(verdict.cacheTtlMs).toBeGreaterThan(0);
  });

  it('reports flagged when the API returns a match, using its cacheDuration', async () => {
    process.env.GOOGLE_SAFE_BROWSING_API_KEY = 'test-key';
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(fakeResponse(true, 200, { matches: [{ cacheDuration: '120s' }] }));

    const verdict = await checkSafeBrowsing('https://evil.example.com');

    expect(verdict.flagged).toBe(true);
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

  it('fails open on a non-2xx response', async () => {
    process.env.GOOGLE_SAFE_BROWSING_API_KEY = 'test-key';
    jest.spyOn(global, 'fetch').mockResolvedValue(fakeResponse(false, 403, {}));

    const verdict = await checkSafeBrowsing('https://example.com');

    expect(verdict.flagged).toBe(false);
  });

  it('fails open when the request throws (network error, timeout)', async () => {
    process.env.GOOGLE_SAFE_BROWSING_API_KEY = 'test-key';
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('network down'));

    const verdict = await checkSafeBrowsing('https://example.com');

    expect(verdict.flagged).toBe(false);
  });
});
