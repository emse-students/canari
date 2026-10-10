/**
 * A backoff bump must not rewrite the payload. On a phone a queued media entry holds the whole
 * file: decoding and re-encrypting it for `attempts + 1` swung the renderer from 160 MB to 1.4 GB
 * every retry (Pixel 6a, 2026-10-10).
 */
import { isOutboxClearPatch } from './outboxCodec';
import { SqliteStorage } from './sqlite';

describe('isOutboxClearPatch', () => {
  it('accepts scheduling-only patches', () => {
    expect(isOutboxClearPatch({ status: 'pending', attempts: 3, nextAttemptAt: 5 })).toBe(true);
  });
  it('refuses a patch that touches the payload, and an empty one', () => {
    expect(isOutboxClearPatch({ attempts: 1, text: 'x' })).toBe(false);
    expect(isOutboxClearPatch({})).toBe(false);
  });
});

describe('SqliteStorage.updateOutboxEntry', () => {
  it('updates a scheduling patch in place, with no SELECT of the payload', async () => {
    const storage = new SqliteStorage('u');
    const execute = vi.fn().mockResolvedValue(undefined);
    const select = vi.fn();
    (storage as unknown as { db: unknown }).db = { execute, select };

    await storage.updateOutboxEntry('id-1', { attempts: 2, nextAttemptAt: 99 }, 'key');

    expect(select).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0]).toContain('UPDATE outbox SET');
    expect(execute.mock.calls[0][1]).toEqual(['id-1', null, 2, null, 99]);
  });
});
