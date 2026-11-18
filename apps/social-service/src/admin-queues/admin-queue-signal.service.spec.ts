import { Logger } from '@nestjs/common';
import { ADMIN_QUEUES_CHANGED_EVENT, AdminQueueSignal } from './admin-queue-signal.service';

/**
 * The admin badges' signal (lead, 2026-11-18): one content-free frame to the accounts the queue's
 * scope SQL names, never a throw. Who those accounts are is proved against PostgreSQL in
 * `bde-moderation.integration.spec`.
 */
describe('AdminQueueSignal', () => {
  let error: jest.SpyInstance;
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  function make(rows: { uid: string }[] | Error) {
    const query = jest.fn(async (_sql: string, _params: unknown[]) => {
      if (rows instanceof Error) throw rows;
      return rows;
    });
    const publishChannelEvent = jest.fn(async () => undefined);
    const signal = new AdminQueueSignal({ query } as never, { publishChannelEvent } as never);
    return { signal, query, publishChannelEvent };
  }

  it('sends one empty frame to each account named once', async () => {
    const { signal, query, publishChannelEvent } = make([{ uid: 'a' }, { uid: 'b' }, { uid: 'a' }]);
    await signal.changed({ queue: 'agenda', associationId: 'asso' });
    expect(query.mock.calls[0][1]).toEqual(['asso']);
    expect(publishChannelEvent).toHaveBeenCalledWith(ADMIN_QUEUES_CHANGED_EVENT, {}, ['a', 'b']);
  });

  it('asks nothing for no report, and sends nothing to nobody', async () => {
    const none = make([{ uid: 'a' }]);
    await none.signal.changed({ queue: 'moderation', reportIds: [] });
    expect(none.query).not.toHaveBeenCalled();
    const nobody = make([]);
    await nobody.signal.changed({ queue: 'profile-corrections' });
    expect(nobody.publishChannelEvent).not.toHaveBeenCalled();
  });

  it('a failure is logged at error and never thrown', async () => {
    const { signal } = make(new Error('db down'));
    await expect(signal.changed({ queue: 'profile-corrections' })).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('NOT told'));
  });
});
