/// <reference types="jest" />

import { Logger } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import {
  APNS_VOIP_GONE,
  PushDeliveryTally,
  pushFailureCode,
  PushDeliveryRecorder,
  recordPushDeliveries,
} from './push-delivery-records';

/**
 * THE PUSH DELIVERY RECORD (migration 054, owner 2026-11-21: "totals + last delivery"): a send batch
 * is counted in memory and written in TWO statements whatever its size - one upsert of its counters,
 * one stamp of its accepted devices - in one deterministic order, and a write that fails is a WARN,
 * never a thrown error on a path whose pushes already left.
 */
describe('push delivery records', () => {
  const android = (id: string) => ({ id, platform: 'android' });
  const ios = (id: string) => ({ id, platform: 'ios' });
  const notRegistered = Object.assign(new Error('Requested entity was not found.'), {
    code: 'messaging/registration-token-not-registered',
  });

  let logger: Logger;
  let warn: jest.SpyInstance;
  beforeEach(() => {
    logger = new Logger('spec');
    warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    jest.spyOn(logger, 'debug').mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  const managerOf = (query: jest.Mock) => ({ query }) as unknown as EntityManager;

  describe('PushDeliveryTally', () => {
    it('counts per platform and outcome, a failure under its code, and attempted = accepted + failed', () => {
      const tally = new PushDeliveryTally('message');
      tally.attempted(android('t1'));
      tally.accepted(android('t1'));
      tally.attempted(android('t2'));
      tally.accepted(android('t2'));
      tally.attempted(ios('t3'));
      tally.failed(ios('t3'), pushFailureCode(notRegistered));
      tally.pruned(ios('t3'));

      expect(tally.rows()).toEqual([
        { platform: 'android', outcome: 'accepted', code: '', count: 2 },
        { platform: 'android', outcome: 'attempted', code: '', count: 2 },
        { platform: 'ios', outcome: 'attempted', code: '', count: 1 },
        {
          platform: 'ios',
          outcome: 'failed',
          code: 'messaging/registration-token-not-registered',
          count: 1,
        },
        { platform: 'ios', outcome: 'pruned', code: '', count: 1 },
      ]);
      expect(tally.acceptedTokenIds()).toEqual(['t1', 't2']);
    });

    it('rows come out in ONE order whatever order the sends settled in', () => {
      const a = new PushDeliveryTally('social');
      a.attempted(ios('x'));
      a.failed(ios('x'), 'messaging/b');
      a.attempted(android('y'));
      a.failed(android('y'), 'messaging/a');
      const b = new PushDeliveryTally('social');
      b.attempted(android('y'));
      b.failed(android('y'), 'messaging/a');
      b.attempted(ios('x'));
      b.failed(ios('x'), 'messaging/b');
      expect(a.rows()).toEqual(b.rows());
    });

    it('names a throw that carries no code `none`, never its prose', () => {
      expect(pushFailureCode(new Error('socket hang up'))).toBe('none');
    });
  });

  describe('recordPushDeliveries', () => {
    it('writes a batch in two statements: the counters, then the accepted devices', async () => {
      const query = jest.fn().mockResolvedValue([]);
      const tally = new PushDeliveryTally('ring');
      tally.attempted(android('t2'));
      tally.accepted(android('t2'));
      tally.attempted(ios('t1'));
      tally.accepted(ios('t1'));
      tally.attempted(ios('t3'));
      tally.failed(ios('t3'), APNS_VOIP_GONE);
      tally.pruned(ios('t3'));

      await recordPushDeliveries(managerOf(query), tally, logger, 'trace');

      expect(query).toHaveBeenCalledTimes(2);
      const [increment, counts] = query.mock.calls[0];
      expect(increment).toMatch(/INSERT INTO push_delivery_daily/);
      expect(increment).toMatch(/ON CONFLICT \("day", "kind", "platform", "outcome", "code"\)/);
      expect(increment).toMatch(/AT TIME ZONE 'UTC'/);
      expect(counts).toEqual([
        'ring',
        ['android', 'android', 'ios', 'ios', 'ios', 'ios'],
        ['accepted', 'attempted', 'accepted', 'attempted', 'failed', 'pruned'],
        ['', '', '', '', APNS_VOIP_GONE, ''],
        [1, 1, 1, 2, 1, 1],
      ]);
      const [stamp, ids] = query.mock.calls[1];
      expect(stamp).toMatch(/"lastPushSentAt"/);
      expect(stamp).toMatch(/ORDER BY "userId", "deviceId" FOR NO KEY UPDATE/);
      expect(ids).toEqual([['t1', 't2']]);
      expect(warn).not.toHaveBeenCalled();
    });

    it('writes nothing for a batch that attempted nothing', async () => {
      const query = jest.fn();
      await recordPushDeliveries(managerOf(query), new PushDeliveryTally('social'), logger, 't');
      expect(query).not.toHaveBeenCalled();
    });

    it('stamps no device when the provider accepted none', async () => {
      const query = jest.fn().mockResolvedValue([]);
      const tally = new PushDeliveryTally('message');
      tally.attempted(android('t1'));
      tally.failed(android('t1'), 'messaging/internal-error');
      await recordPushDeliveries(managerOf(query), tally, logger, 't');
      expect(query).toHaveBeenCalledTimes(1);
    });

    it('a failed increment is a WARN naming what was lost, never a throw - and the stamp still runs', async () => {
      const query = jest
        .fn()
        .mockRejectedValueOnce(new Error('relation "push_delivery_daily" does not exist'))
        .mockResolvedValueOnce([]);
      const tally = new PushDeliveryTally('message');
      tally.attempted(android('t1'));
      tally.accepted(android('t1'));

      await expect(
        recordPushDeliveries(managerOf(query), tally, logger, 'tr')
      ).resolves.toBeUndefined();

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain(
        '[PUSH_RECORD][tr] daily counts NOT recorded kind=message android/accepted=1 android/attempted=1'
      );
      expect(query).toHaveBeenCalledTimes(2);
    });

    it('a failed stamp is a WARN, never a throw', async () => {
      const query = jest.fn().mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('down'));
      const tally = new PushDeliveryTally('social');
      tally.attempted(ios('t1'));
      tally.accepted(ios('t1'));
      await expect(
        recordPushDeliveries(managerOf(query), tally, logger, 'tr')
      ).resolves.toBeUndefined();
      expect(warn.mock.calls[0][0]).toContain(
        'lastPushSentAt NOT stamped kind=social on 1 device(s)'
      );
    });
  });

  describe('PushDeliveryRecorder', () => {
    /** A query that stays pending until the test releases it, so a write is provably in flight. */
    const gatedQuery = () => {
      const releases: Array<() => void> = [];
      const query = jest.fn(
        (_sql: string, _params?: unknown[]): Promise<unknown[]> =>
          new Promise<unknown[]>((resolve) => {
            releases.push(() => resolve([]));
          })
      );
      const release = () => releases.splice(0).forEach((r) => r());
      return { query, release };
    };
    const batch = (kind: 'message' | 'social', id: string) => {
      const tally = new PushDeliveryTally(kind);
      tally.attempted(android(id));
      tally.accepted(android(id));
      return tally;
    };

    it('folds every batch handed over during a write into ONE next write per kind', async () => {
      jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
      const recorder = new PushDeliveryRecorder();
      const { query, release } = gatedQuery();
      const manager = managerOf(query);

      recorder.record(manager, batch('message', 't1'), 'tr-1');
      await new Promise((resolve) => setImmediate(resolve));
      // The first write is in flight: these three wait, and become one write.
      recorder.record(manager, batch('message', 't2'), 'tr-2');
      recorder.record(manager, batch('message', 't3'), 'tr-3');
      recorder.record(manager, batch('message', 't2'), 'tr-4');
      let done = false;
      void recorder.settled().then(() => {
        done = true;
      });
      while (!done) {
        release();
        await new Promise((resolve) => setImmediate(resolve));
      }

      const increments = query.mock.calls.filter(([sql]) =>
        String(sql).includes('push_delivery_daily')
      );
      expect(increments.map(([, p]) => (p as unknown[])[4])).toEqual([
        [1, 1],
        [3, 3],
      ]);
      const stamps = query.mock.calls.filter(([sql]) => String(sql).includes('"lastPushSentAt"'));
      expect(stamps.map(([, p]) => p)).toEqual([[['t1']], [['t2', 't3']]]);
    });

    it('stamps every device that fetched since the last write in ONE statement, each once', async () => {
      jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
      const recorder = new PushDeliveryRecorder();
      const query = jest.fn().mockResolvedValue([]);
      const manager = managerOf(query);

      recorder.fetched(manager, 'user-1', 'phone-1', 'wake');
      recorder.fetched(manager, 'user-2', 'tablet', 'fetch-proto');
      recorder.fetched(manager, 'user-1', 'phone-1', 'wake');
      await recorder.settled();

      expect(query).toHaveBeenCalledTimes(1);
      expect(query.mock.calls[0][0]).toMatch(/SET "lastPushFetchedAt"/);
      expect(query.mock.calls[0][0]).toMatch(
        /ORDER BY t\."userId", t\."deviceId" FOR NO KEY UPDATE/
      );
      expect(query.mock.calls[0][1]).toEqual([
        ['user-1', 'user-2'],
        ['phone-1', 'tablet'],
      ]);
    });

    it('a failed fetch stamp is a WARN naming the devices and routes, never a throw', async () => {
      const warnAll = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
      jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
      const recorder = new PushDeliveryRecorder();
      const query = jest.fn().mockRejectedValue(new Error('down'));
      recorder.fetched(managerOf(query), 'user-1', 'phone-1', 'fetch-proto');
      await expect(recorder.settled()).resolves.toBeUndefined();
      expect(String(warnAll.mock.calls[0][0])).toContain(
        '[PUSH_RECORD] lastPushFetchedAt NOT stamped on 1 device(s) routes=fetch-proto'
      );
    });

    it('at exit, SAYS what is pending before it waits - so a SIGKILL after the grace leaves the line', async () => {
      jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
      const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
      const recorder = new PushDeliveryRecorder();
      const { query, release } = gatedQuery();
      const manager = managerOf(query);
      recorder.record(manager, batch('message', 't1'), 'tr-1');
      await new Promise((resolve) => setImmediate(resolve));
      recorder.record(manager, batch('social', 't2'), 'tr-2');
      recorder.record(manager, batch('social', 't3'), 'tr-3');
      recorder.fetched(manager, 'user-1', 'phone-1', 'wake');

      const exit = recorder.drainForExit();
      // Synchronously: nothing was awaited between the call and this line.
      expect(log).toHaveBeenCalledTimes(1);
      expect(String(log.mock.calls[0][0])).toBe(
        '[PUSH_RECORD] exit - not yet written: attempted social:2, 1 fetched device(s); ' +
          'write in flight: trace=tr-1 kinds=message fetched=0 - waiting for the writer'
      );

      let done = false;
      void exit.then(() => {
        done = true;
      });
      while (!done) {
        release();
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(query.mock.calls.some(([sql]) => String(sql).includes('"lastPushFetchedAt"'))).toBe(
        true
      );
    });

    it('at exit, SAYS how many send batches are still sending, then waits until each handed its tally over', async () => {
      jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
      const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
      const recorder = new PushDeliveryRecorder();
      const query = jest.fn().mockResolvedValue([]);
      let pushesSettle: () => void = () => {};
      const pushes = new Promise<void>((resolve) => {
        pushesSettle = resolve;
      });
      // The fan-out's shape: the batch hands its tally over once its pushes settled.
      recorder.trackBatch(
        pushes.then(() => recorder.record(managerOf(query), batch('message', 't1'), 'tr-1'))
      );
      // A batch whose pushes failed is waited for too, and never rejects the exit.
      recorder.trackBatch(Promise.reject(new Error('fcm down')));

      const exit = recorder.finishBatchesInFlight();
      expect(String(log.mock.calls[0][0])).toBe(
        '[PUSH_RECORD] exit - 2 send batch(es) still waiting on their pushes - waiting for them'
      );
      pushesSettle();
      await exit;
      await recorder.drainForExit();

      expect(
        query.mock.calls.filter(([sql]) => String(sql).includes('push_delivery_daily'))
      ).toHaveLength(1);
      await recorder.finishBatchesInFlight();
      expect(log).toHaveBeenCalledTimes(2);
    });

    it('at exit, says nothing when nothing is pending', async () => {
      const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
      await new PushDeliveryRecorder().drainForExit();
      expect(log).not.toHaveBeenCalled();
    });

    it('a writer that throws is an ERROR naming what it dropped, and the recorder writes again', async () => {
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
      const debug = jest.spyOn(Logger.prototype, 'debug').mockImplementationOnce(() => {
        throw new Error('boom');
      });
      const recorder = new PushDeliveryRecorder();
      const query = jest.fn().mockResolvedValue([]);
      recorder.record(managerOf(query), batch('message', 't1'), 'tr-1');
      await recorder.settled();
      expect(String(error.mock.calls[0][0])).toBe(
        '[PUSH_RECORD] the writer failed - DROPPED trace=tr-1 kinds=message fetched=0: Error: boom'
      );

      debug.mockImplementation(() => {});
      recorder.record(managerOf(query), batch('message', 't2'), 'tr-2');
      await recorder.settled();
      expect(query.mock.calls.some(([, p]) => JSON.stringify(p) === '[["t2"]]')).toBe(true);
    });

    it('starts a new write for a hand-over that arrives after the last one ended', async () => {
      jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
      const recorder = new PushDeliveryRecorder();
      const query = jest.fn().mockResolvedValue([]);
      const manager = managerOf(query);
      recorder.record(manager, batch('social', 't1'), 'a');
      await recorder.settled();
      recorder.record(manager, batch('social', 't2'), 'b');
      await recorder.settled();
      const stamps = query.mock.calls.filter(([sql]) => String(sql).includes('"lastPushSentAt"'));
      expect(stamps.map(([, p]) => p)).toEqual([[['t1']], [['t2']]]);
    });
  });
});
