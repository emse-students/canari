import { Logger } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { RetentionBootNotice } from './retention-boot-notice';

/**
 * Social-service's boot notice to media-service: one POST behind the internal secret CARRYING the two
 * durations it read from `platform_config`, never a throw. The values travel with the notice because
 * a read media-service makes in answer goes through the mesh, which during this replica's boot still
 * routes to the retiring replica (docs/wiki/retention-settings.md, the 2026-11-15 rolling deploy).
 */
describe('RetentionBootNotice', () => {
  const row = {
    retention_reel_days: 365,
    retention_live_replay_days: 3,
    retention_chat_reel_days: 14,
    retention_idle_file_days: 60,
  };
  const dbWith = (query: jest.Mock) => ({ manager: { query } }) as unknown as DataSource;
  const holding = () => dbWith(jest.fn(() => Promise.resolve([row])));
  const answering = (status: number, body: unknown) =>
    jest.fn(() =>
      Promise.resolve(new Response(JSON.stringify(body), { status }))
    ) as unknown as typeof fetch;

  it('POSTs the notice to media-service with the internal secret and the durations it read', async () => {
    process.env.INTERNAL_SECRET = 'shh';
    const fetchImpl = answering(201, { refreshed: true, readAt: '2026-11-14T12:00:00.000Z' });
    await expect(new RetentionBootNotice(holding()).send(fetchImpl)).resolves.toBe(true);
    const [url, init] = jest.mocked(fetchImpl).mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/api\/media\/internal\/retention-changed$/);
    expect(init).toMatchObject({
      method: 'POST',
      headers: { 'x-internal-secret': 'shh', 'content-type': 'application/json' },
    });
    expect(JSON.parse(init.body as string)).toEqual({ chatReelDays: 14, idleFileDays: 60 });
  });

  it('sends nothing when the durations cannot be read: there is nothing to hand over', async () => {
    const fetchImpl = answering(201, { refreshed: true });
    const db = dbWith(jest.fn(() => Promise.reject(new Error('connection terminated'))));
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await expect(new RetentionBootNotice(db).send(fetchImpl)).resolves.toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining(
        '[RETENTION] the retention durations could not be read at this boot, so none were handed to media-service: connection terminated'
      )
    );
    error.mockRestore();
  });

  it('resolves false on a refusal, a failed re-read or an unreachable media-service', async () => {
    const notice = new RetentionBootNotice(holding());
    await expect(notice.send(answering(401, {}))).resolves.toBe(false);
    await expect(notice.send(answering(201, { refreshed: false }))).resolves.toBe(false);
    const down = jest.fn(() =>
      Promise.reject(new Error('ECONNREFUSED'))
    ) as unknown as typeof fetch;
    await expect(notice.send(down)).resolves.toBe(false);
  });
});
