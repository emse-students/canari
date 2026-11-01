import { describe, expect, it, vi } from 'vitest';
import { cachedCommitInstants, readServerInstant, type ServerInstant } from './serverInstant';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('readServerInstant - a status is an answer, classified at the throw', () => {
  it('reads the instant, and a null as no record', async () => {
    await expect(
      readServerInstant(json(200, { acceptedAt: '2026-11-01T09:00:00.000Z' }), 'acceptedAt')
    ).resolves.toEqual({ kind: 'at', at: Date.parse('2026-11-01T09:00:00.000Z') });
    await expect(readServerInstant(json(200, { acceptedAt: null }), 'acceptedAt')).resolves.toEqual(
      { kind: 'none' }
    );
  });

  it('a 403 is a refusal and a 404 an unserved route; anything else is no answer', async () => {
    await expect(readServerInstant(json(403, {}), 'acceptedAt')).resolves.toEqual({
      kind: 'refused',
    });
    await expect(readServerInstant(json(404, {}), 'acceptedAt')).resolves.toEqual({
      kind: 'unserved',
    });
    await expect(readServerInstant(json(503, {}), 'acceptedAt')).resolves.toBeNull();
  });

  it('throws on an unparseable instant', async () => {
    await expect(readServerInstant(json(200, { removedAt: 'x' }), 'removedAt')).rejects.toThrow(
      'unparseable'
    );
  });
});

describe('cachedCommitInstants - a log row never changes, so it is asked once', () => {
  it('keeps an instant and a missing row for the session, never a refusal', async () => {
    const answers: Record<string, ServerInstant> = {
      'g:1': { kind: 'at', at: 5 },
      'g:2': { kind: 'none' },
      'g:3': { kind: 'refused' },
    };
    const fetch = vi.fn(async (g: string, e: number) => answers[`${g}:${e}`]);
    const ask = cachedCommitInstants(fetch);
    for (let i = 0; i < 2; i++) {
      await expect(ask('g', 1)).resolves.toEqual({ kind: 'at', at: 5 });
      await expect(ask('g', 2)).resolves.toEqual({ kind: 'none' });
      await expect(ask('g', 3)).resolves.toEqual({ kind: 'refused' });
    }
    expect(fetch.mock.calls.map((c) => c[1])).toEqual([1, 2, 3, 3]);
  });

  it('an unserved route is said ONCE and never asked again this session', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetch = vi.fn(async (): Promise<ServerInstant> => ({ kind: 'unserved' }));
    const ask = cachedCommitInstants(fetch);
    await ask('g', 1);
    await ask('h', 7);
    await expect(ask('g', 2)).resolves.toEqual({ kind: 'unserved' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });

  it('no answer is thrown, and asked again next time', async () => {
    const fetch = vi
      .fn<(g: string, e: number) => Promise<ServerInstant>>()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce({ kind: 'at', at: 9 });
    const ask = cachedCommitInstants(fetch);
    await expect(ask('g', 1)).rejects.toThrow('network');
    await expect(ask('g', 1)).resolves.toEqual({ kind: 'at', at: 9 });
  });
});
