import { RetentionBootNotice } from './retention-boot-notice';

/** Social-service's boot notice to media-service: one POST behind the internal secret, never a throw. */
describe('RetentionBootNotice', () => {
  const answering = (status: number, body: unknown) =>
    jest.fn(() =>
      Promise.resolve(new Response(JSON.stringify(body), { status }))
    ) as unknown as typeof fetch;

  it('POSTs the notice to media-service with the internal secret', async () => {
    process.env.INTERNAL_SECRET = 'shh';
    const fetchImpl = answering(200, { refreshed: true, readAt: '2026-11-14T12:00:00.000Z' });
    await expect(new RetentionBootNotice().send(fetchImpl)).resolves.toBe(true);
    const [url, init] = jest.mocked(fetchImpl).mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/api\/media\/internal\/retention-changed$/);
    expect(init).toMatchObject({ method: 'POST', headers: { 'x-internal-secret': 'shh' } });
  });

  it('resolves false on a refusal, a failed re-read or an unreachable media-service', async () => {
    const notice = new RetentionBootNotice();
    await expect(notice.send(answering(401, {}))).resolves.toBe(false);
    await expect(notice.send(answering(200, { refreshed: false }))).resolves.toBe(false);
    const down = jest.fn(() =>
      Promise.reject(new Error('ECONNREFUSED'))
    ) as unknown as typeof fetch;
    await expect(notice.send(down)).resolves.toBe(false);
  });
});
