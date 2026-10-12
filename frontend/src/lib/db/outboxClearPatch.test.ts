/**
 * A backoff bump must not rewrite the payload. On a phone a queued media entry holds the whole
 * file: decoding and re-encrypting it for `attempts + 1` swung the renderer from 160 MB to 1.4 GB
 * every retry (Pixel 6a, 2026-10-10).
 */
import { isOutboxClearPatch, OutboxPayloadUnreadableError } from './outboxCodec';
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

describe('SqliteStorage.getOutboxQueue', () => {
  it('never selects the payload of a media row, and decodes no file for it', async () => {
    const storage = new SqliteStorage('u');
    const select = vi.fn().mockResolvedValue([
      {
        id: 'm1',
        conversation_id: 'g',
        sent_at: 1,
        kind: 'media',
        status: 'pending',
        attempts: 4,
        last_attempt_at: null,
        next_attempt_at: 9,
        created_at: 1,
        iv: null,
        cipher_text: null,
      },
    ]);
    (storage as unknown as { db: unknown }).db = { execute: vi.fn(), select };

    const queue = await storage.getOutboxQueue('key');

    expect(select.mock.calls[0][0]).toContain(
      "CASE WHEN kind = 'media' THEN NULL ELSE cipher_text END"
    );
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ id: 'm1', kind: 'media', attempts: 4, nextAttemptAt: 9 });
    expect(queue[0].media).toBeUndefined();
  });
});

describe('SqliteStorage.getOutboxEntry', () => {
  it('is null for an absent row and typed when the payload cannot be read', async () => {
    const storage = new SqliteStorage('u');
    const select = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: 'm1',
          conversation_id: 'g',
          sent_at: 1,
          kind: 'media',
          status: 'pending',
          iv: '',
          cipher_text: '',
          created_at: 1,
        },
      ]);
    (storage as unknown as { db: unknown }).db = { execute: vi.fn(), select };
    expect(await storage.getOutboxEntry('nope', 'key')).toBeNull();
    await expect(storage.getOutboxEntry('m1', 'not-a-key')).rejects.toBeInstanceOf(
      OutboxPayloadUnreadableError
    );
  });
});

describe('the in-place patch keeps a zero', () => {
  it('binds attempts: 0 as 0, not as null (COALESCE would keep the old value)', async () => {
    const storage = new SqliteStorage('u');
    const execute = vi.fn().mockResolvedValue(undefined);
    (storage as unknown as { db: unknown }).db = { execute, select: vi.fn() };
    await storage.updateOutboxEntry('id-1', { attempts: 0, nextAttemptAt: 0 }, 'key');
    expect(execute.mock.calls[0][1]).toEqual(['id-1', null, 0, null, 0]);
  });
});
