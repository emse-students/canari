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
  const held = (chatReelDays: number, idleFileDays: number) =>
    ({ kind: 'held', held: { chatReelDays, idleFileDays }, readAt: null }) as const;

  it('is applied only when media-service holds exactly the configured values', () => {
    expect(retentionAppliedState(configured, held(7, 90))).toBe('applied');
  });

  it('is behind when the notice was lost (the old value held) or nothing is held yet', () => {
    expect(retentionAppliedState(configured, held(30, 90))).toBe('behind');
    expect(retentionAppliedState(configured, { kind: 'held', held: null, readAt: null })).toBe(
      'behind'
    );
  });

  it('keeps an ANSWER (refused) apart from a transport failure (unreachable)', () => {
    expect(
      retentionAppliedState(configured, { kind: 'refused', status: 401, reason: 'secret' })
    ).toBe('refused');
    expect(retentionAppliedState(configured, { kind: 'unreachable', cause: 'ECONNREFUSED' })).toBe(
      'unreachable'
    );
  });
});

describe('readMediaRetentionHeld', () => {
  const answering = (status: number, body: unknown) =>
    jest.fn(() =>
      Promise.resolve(
        new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
      )
    ) as unknown as typeof fetch;

  it('reads what media-service holds, behind the internal secret', async () => {
    process.env.INTERNAL_SECRET = 'shh';
    const fetchImpl = answering(200, {
      held: { chatReelDays: 30, idleFileDays: 90 },
      readAt: '2026-11-14T12:00:00.000Z',
    });
    await expect(readMediaRetentionHeld(fetchImpl)).resolves.toEqual({
      kind: 'held',
      held: { chatReelDays: 30, idleFileDays: 90 },
      readAt: '2026-11-14T12:00:00.000Z',
    });
    const [url, init] = jest.mocked(fetchImpl).mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/api\/media\/internal\/retention$/);
    expect(init.headers).toEqual({ 'x-internal-secret': 'shh' });
  });

  it('reports nothing held as held: null', async () => {
    await expect(
      readMediaRetentionHeld(answering(200, { held: null, readAt: null }))
    ).resolves.toEqual({ kind: 'held', held: null, readAt: null });
  });

  it.each([
    [401, 'secret'],
    [403, 'secret'],
    [404, 'route'],
    [500, 'status'],
  ] as const)('a %i is an ANSWER: refused, %s', async (status, reason) => {
    await expect(readMediaRetentionHeld(answering(status, {}))).resolves.toEqual({
      kind: 'refused',
      status,
      reason,
    });
  });

  it('a 2xx whose body is not the shape is refused as malformed', async () => {
    await expect(readMediaRetentionHeld(answering(200, 'not json'))).resolves.toEqual({
      kind: 'refused',
      status: 200,
      reason: 'malformed',
    });
    await expect(
      readMediaRetentionHeld(answering(200, { held: { chatReelDays: '30' } }))
    ).resolves.toMatchObject({ kind: 'refused', reason: 'malformed' });
  });

  it('a transport failure is unreachable, with its cause, and never throws', async () => {
    const down = jest.fn(() =>
      Promise.reject(new Error('ECONNREFUSED'))
    ) as unknown as typeof fetch;
    await expect(readMediaRetentionHeld(down)).resolves.toEqual({
      kind: 'unreachable',
      cause: 'ECONNREFUSED',
    });
  });
});
