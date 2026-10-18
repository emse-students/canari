import { runRestoreReplay, type RestoreReplayIo } from './restore-replay';

/**
 * The client `restore.sh` runs inside the container: it must reach the two internal routes on this
 * container's own port with its secret, and turn ANY failure into a non-zero exit - a restore that
 * carried on after a failed export would replace the only record of the erasures it owes.
 */
describe('restore-replay client', () => {
  function io(status: number, body: string, env: Record<string, string> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const fetch = jest.fn(async () => new Response(body, { status }));
    const value: RestoreReplayIo = {
      env: { INTERNAL_SECRET: 's3cret', PORT: '3999', ...env },
      fetch: fetch as unknown as typeof globalThis.fetch,
      readStdin: async () => '{"completed":[],"pending":[]}',
      out: (t) => out.push(t),
      err: (t) => err.push(t),
    };
    return { value, fetch, out, err };
  }

  it('exports the journal from its own port, with its secret, to stdout', async () => {
    const t = io(200, '{"completed":[],"pending":["a"]}');
    await expect(runRestoreReplay('export', t.value)).resolves.toBe(0);
    expect(t.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3999/api/internal/account-erasure/journal',
      { headers: { 'x-internal-secret': 's3cret' } }
    );
    expect(t.out.join('')).toBe('{"completed":[],"pending":["a"]}\n');
  });

  it('posts stdin to the replay route', async () => {
    const t = io(200, '{"candidates":0,"replayed":0,"keptNewer":0}');
    await expect(runRestoreReplay('replay', t.value)).resolves.toBe(0);
    const [url, init] = t.fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:3999/api/internal/account-erasure/replay');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"completed":[],"pending":[]}');
  });

  it('exits non-zero on a refusal, an empty secret or an unknown mode', async () => {
    const refused = io(400, '{"code":"MALFORMED_ERASURE_JOURNAL"}');
    await expect(runRestoreReplay('replay', refused.value)).resolves.toBe(1);
    expect(refused.err.join('')).toContain('HTTP 400');

    const noSecret = io(200, '{}', { INTERNAL_SECRET: '' });
    await expect(runRestoreReplay('export', noSecret.value)).resolves.toBe(1);
    expect(noSecret.fetch).not.toHaveBeenCalled();

    await expect(runRestoreReplay('wipe', io(200, '{}').value)).resolves.toBe(2);
  });
});
