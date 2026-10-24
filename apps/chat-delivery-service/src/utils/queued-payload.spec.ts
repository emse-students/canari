/// <reference types="jest" />

import type { EntityManager } from 'typeorm';
import { QueuedMessage } from '../entities/queued-message.entity';
import { QueuedPayload } from '../entities/queued-payload.entity';
import {
  collectUnreferencedPayloads,
  materializeDeliveries,
  readSharedPayloadWrites,
  saveWithSharedPayload,
  sharesPayload,
} from './queued-payload';

/**
 * A KEY-GROUP FRAME IS STORED ONCE, AND EVERY DEVICE STILL GETS THE ROW IT ALWAYS GOT.
 *
 * What a mocked manager can pin is the DECISION and the SHAPE: which sends share, that N records
 * cost one payload row, that a reader hands back exactly the pre-034 row. The SQL itself - the
 * collector's anti-join and the per-device ACK against a real table - is pinned by
 * `queued-payload.integration.spec.ts` against PostgreSQL.
 */
const KEY_GROUP = { distributionWorkspaceId: 'ws-1', distributionChannelId: null };
const DM = { distributionWorkspaceId: null, distributionChannelId: null };

const record = (deviceId: string, proto = 'Y2lwaGVy'): QueuedMessage =>
  Object.assign(new QueuedMessage(), {
    recipientId: `u-${deviceId}`,
    deviceId,
    groupId: 'g-1',
    proto,
    createdAt: new Date('2026-10-22T10:00:00Z'),
  });

describe('readSharedPayloadWrites - the writer ships OFF, behind the readers', () => {
  const logger = { log: jest.fn() };

  it('is OFF when unset or "false" - the per-seat inline write every older image can serve', () => {
    expect(readSharedPayloadWrites(undefined, logger)).toBe(false);
    expect(readSharedPayloadWrites('', logger)).toBe(false);
    expect(readSharedPayloadWrites('false', logger)).toBe(false);
  });

  it('is ON only for "true"', () => {
    expect(readSharedPayloadWrites('true', logger)).toBe(true);
    expect(readSharedPayloadWrites(' true ', logger)).toBe(true);
  });

  it('refuses anything else, so a typo stops the boot instead of being read as either state', () => {
    for (const raw of ['1', 'TRUE', 'on', 'yes', 'fals']) {
      expect(() => readSharedPayloadWrites(raw, logger)).toThrow(/QUEUED_PAYLOAD_SHARED_WRITES/);
    }
  });
});

describe('sharesPayload', () => {
  it('shares a key-group fan-out to several seats', () => {
    expect(sharesPayload(KEY_GROUP, [record('a'), record('b'), record('c')])).toBe(true);
    expect(
      sharesPayload({ distributionWorkspaceId: null, distributionChannelId: 'ch-1' }, [
        record('a'),
        record('b'),
      ])
    ).toBe(true);
  });

  it('leaves a DM or a group conversation exactly as it was, one inline row per device', () => {
    expect(sharesPayload(DM, [record('a'), record('b'), record('c')])).toBe(false);
  });

  it('does not pay a second row for a frame queued to ONE seat (an addressed answer)', () => {
    expect(sharesPayload(KEY_GROUP, [record('a')])).toBe(false);
  });

  it('never shares records that do not carry the same ciphertext', () => {
    expect(sharesPayload(KEY_GROUP, [record('a', 'AAAA'), record('b', 'BBBB')])).toBe(false);
  });

  it('never shares a Welcome, which carries its own tree and one addressee', () => {
    const w = Object.assign(record('b'), { isWelcome: true });
    expect(sharesPayload(KEY_GROUP, [record('a'), w])).toBe(false);
  });
});

describe('saveWithSharedPayload', () => {
  const makeManager = () => {
    const payloadSaves: Partial<QueuedPayload>[] = [];
    const recordSaves: Partial<QueuedMessage>[][] = [];
    const manager = {
      getRepository: (entity: unknown) => {
        if (entity === QueuedPayload) {
          return {
            save: async (p: Partial<QueuedPayload>) => {
              payloadSaves.push({ ...p });
              return { ...p, id: 'payload-1' };
            },
          };
        }
        return {
          save: async (rows: QueuedMessage[]) => {
            // A snapshot: what is STORED, before the in-memory proto is put back.
            recordSaves.push(rows.map((r) => ({ ...r })));
            return rows.map((r, i) => Object.assign(r, { id: `rec-${i}` }));
          },
        };
      },
    } as unknown as EntityManager;
    return { manager, payloadSaves, recordSaves };
  };

  it('writes N seats as ONE payload row and N delivery records pointing at it', async () => {
    const { manager, payloadSaves, recordSaves } = makeManager();
    const rows = ['a', 'b', 'c', 'd', 'e'].map((d) => record(d));

    await saveWithSharedPayload(manager, 'g-1', rows);

    expect(payloadSaves).toEqual([
      { groupId: 'g-1', proto: 'Y2lwaGVy', createdAt: new Date('2026-10-22T10:00:00Z') },
    ]);
    expect(recordSaves).toHaveLength(1);
    expect(recordSaves[0]).toHaveLength(5);
    for (const stored of recordSaves[0]) {
      expect(stored.payloadId).toBe('payload-1');
      expect(stored.proto).toBeUndefined();
    }
  });

  it('hands the records back with their ciphertext, because the realtime envelope is built from them', async () => {
    const { manager } = makeManager();

    const saved = await saveWithSharedPayload(manager, 'g-1', [record('a'), record('b')]);

    expect(saved.map((r) => r.proto)).toEqual(['Y2lwaGVy', 'Y2lwaGVy']);
    expect(saved.map((r) => r.id)).toEqual(['rec-0', 'rec-1']);
  });
});

describe('materializeDeliveries', () => {
  const logger = { error: jest.fn() };
  const payload = (id: string, proto: string) =>
    Object.assign(new QueuedPayload(), { id, proto, groupId: 'g-1' });

  beforeEach(() => logger.error.mockClear());

  it('puts the joined ciphertext back and removes the storage-only keys, so the wire shape is unchanged', () => {
    const shared = Object.assign(record('a'), {
      proto: undefined,
      payloadId: 'p-1',
      payload: payload('p-1', 'U0hBUkVE'),
    });
    const inline = Object.assign(record('b', 'SU5MSU5F'), { payloadId: null, payload: null });

    materializeDeliveries([shared, inline], logger, 't');

    expect(shared.proto).toBe('U0hBUkVE');
    expect(inline.proto).toBe('SU5MSU5F');
    for (const row of [shared, inline]) {
      expect('payloadId' in row).toBe(false);
      expect('payload' in row).toBe(false);
    }
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('leaves an inline row - every old row and every non-key-group row - exactly as it was', () => {
    const old = record('a', 'T0xE');

    materializeDeliveries([old], logger, 't');

    expect(old.proto).toBe('T0xE');
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('accuses a record whose payload is gone and WITHHOLDS it - never an empty frame a device would ACK', () => {
    const before = Object.assign(record('a', 'QkVGT1JF'), { id: 'r-1' });
    const orphan = Object.assign(record('b'), {
      id: 'r-2',
      proto: undefined,
      payloadId: 'p-gone',
      payload: null,
    });
    const after = Object.assign(record('c', 'QUZURVI='), { id: 'r-3' });

    const out = materializeDeliveries([before, orphan, after], logger, 't');

    expect(out.map((r) => r.id)).toEqual(['r-1', 'r-3']);
    expect(out.every((r) => !!r.proto)).toBe(true);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('r-2->p-gone'));
  });
});

describe('collectUnreferencedPayloads', () => {
  it('deletes by the absence of any referencing record - an allowlist read in the same statement', async () => {
    const query = jest.fn(async (..._args: unknown[]) => [[], 4]);
    const manager = {
      query,
      getRepository: (entity: unknown) => ({
        metadata: { tableName: entity === QueuedPayload ? 'queued_payload' : 'queued_message' },
      }),
    } as unknown as EntityManager;

    expect(await collectUnreferencedPayloads(manager)).toBe(4);
    const sql = query.mock.calls[0][0] as string;
    expect(sql).toMatch(/^DELETE FROM "queued_payload" p WHERE NOT EXISTS/);
    expect(sql).toContain('q."payloadId" = p.id');
    // No clock: age is never the reason a payload goes.
    expect(sql).not.toMatch(/createdAt|now\(\)|interval/i);
  });
});
