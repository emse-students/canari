import { notifyMediaRetentionChanged } from './retention-notice';

/** The notice to media-service: one POST behind the internal secret, never a throw. */
describe('notifyMediaRetentionChanged', () => {
  const logger = () => ({ log: jest.fn(), error: jest.fn() });
  const answering = (status: number, body: unknown) =>
    jest.fn(() =>
      Promise.resolve(new Response(JSON.stringify(body), { status }))
    ) as unknown as typeof fetch;

  it('POSTs the notice to media-service with the internal secret and reports the re-read', async () => {
    process.env.INTERNAL_SECRET = 'shh';
    const fetchImpl = answering(200, { refreshed: true, readAt: '2026-11-14T12:00:00.000Z' });
    const log = logger();
    await expect(notifyMediaRetentionChanged(log, fetchImpl)).resolves.toBe(true);
    const [url, init] = jest.mocked(fetchImpl).mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/api\/media\/internal\/retention-changed$/);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'x-internal-secret': 'shh' });
    expect(log.error).not.toHaveBeenCalled();
  });

  it('accuses a refusal, a failed re-read and an unreachable service, without throwing', async () => {
    const log = logger();
    await expect(notifyMediaRetentionChanged(log, answering(401, {}))).resolves.toBe(false);
    await expect(
      notifyMediaRetentionChanged(log, answering(200, { refreshed: false, readAt: null }))
    ).resolves.toBe(false);
    const down = jest.fn(() =>
      Promise.reject(new Error('ECONNREFUSED'))
    ) as unknown as typeof fetch;
    await expect(notifyMediaRetentionChanged(log, down)).resolves.toBe(false);
    expect(log.error).toHaveBeenCalledTimes(3);
  });
});
