/// <reference types="jest" />

import { Logger } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import {
  APNS_VOIP_GONE,
  PushDeliveryTally,
  pushFailureCode,
  recordPushDeliveries,
  stampPushFetched,
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

  describe('stampPushFetched', () => {
    it('stamps the one registration that fetched', async () => {
      const query = jest.fn().mockResolvedValue([]);
      await stampPushFetched(managerOf(query), 'user-1', 'phone-1', logger, 'wake');
      expect(query.mock.calls[0][0]).toMatch(/SET "lastPushFetchedAt"/);
      expect(query.mock.calls[0][1]).toEqual(['user-1', 'phone-1']);
    });

    it('a failed stamp is a WARN naming the route, never a throw', async () => {
      const query = jest.fn().mockRejectedValue(new Error('down'));
      await expect(
        stampPushFetched(managerOf(query), 'user-1', 'phone-1', logger, 'fetch-proto')
      ).resolves.toBeUndefined();
      expect(warn.mock.calls[0][0]).toContain(
        '[PUSH_RECORD] lastPushFetchedAt NOT stamped route=fetch-proto'
      );
    });
  });
});
