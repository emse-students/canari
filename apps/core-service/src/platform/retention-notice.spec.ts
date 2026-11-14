import {
  notifyMediaRetentionChanged,
  readMediaRetentionHeld,
  retentionAppliedState,
} from './retention-notice';

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

/** What media-service holds, compared with the columns: the admin page's "pas encore appliqué". */
describe('retentionAppliedState - the values are the version', () => {
  const configured = { chatReelDays: 7, idleFileDays: 90 };

  it('is applied only when media-service holds exactly the configured values', () => {
    expect(retentionAppliedState(configured, { held: { chatReelDays: 7, idleFileDays: 90 } })).toBe(
      'applied'
    );
  });

  it('is behind when the notice was lost (the old value held) or nothing is held yet', () => {
    expect(
      retentionAppliedState(configured, { held: { chatReelDays: 30, idleFileDays: 90 } })
    ).toBe('behind');
    expect(retentionAppliedState(configured, { held: null })).toBe('behind');
  });

  it('says unreachable when media-service could not be asked', () => {
    expect(retentionAppliedState(configured, 'unreachable')).toBe('unreachable');
  });
});

describe('readMediaRetentionHeld', () => {
  const answering = (status: number, body: unknown) =>
    jest.fn(() =>
      Promise.resolve(new Response(JSON.stringify(body), { status }))
    ) as unknown as typeof fetch;

  it('reads what media-service holds, behind the internal secret', async () => {
    process.env.INTERNAL_SECRET = 'shh';
    const fetchImpl = answering(200, {
      held: { chatReelDays: 30, idleFileDays: 90 },
      readAt: '2026-11-14T12:00:00.000Z',
    });
    await expect(readMediaRetentionHeld({ warn: jest.fn() }, fetchImpl)).resolves.toEqual({
      held: { chatReelDays: 30, idleFileDays: 90 },
      readAt: '2026-11-14T12:00:00.000Z',
    });
    const [url, init] = jest.mocked(fetchImpl).mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/api\/media\/internal\/retention$/);
    expect(init.headers).toEqual({ 'x-internal-secret': 'shh' });
  });

  it('reports nothing held, and unreachable on a refusal or a dead service, without throwing', async () => {
    const warn = jest.fn();
    await expect(
      readMediaRetentionHeld({ warn }, answering(200, { held: null, readAt: null }))
    ).resolves.toEqual({ held: null, readAt: null });
    await expect(readMediaRetentionHeld({ warn }, answering(401, {}))).resolves.toBe('unreachable');
    const down = jest.fn(() =>
      Promise.reject(new Error('ECONNREFUSED'))
    ) as unknown as typeof fetch;
    await expect(readMediaRetentionHeld({ warn }, down)).resolves.toBe('unreachable');
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
