/// <reference types="jest" />

import { Logger } from '@nestjs/common';
import { RedisService } from './redis.service';

/**
 * A DEFAULT NOBODY CHOSE RAN AN ESTATE FOR SEVEN DAYS, AND THE ONLY REPORT WAS A REPEATING ERROR.
 *
 * `REDIS_URL` is set for social-service on production and on the local stack, and was simply absent
 * from `docker-compose.dev.yml`. So this service dialled `redis://localhost:6379` - inside a
 * container, itself - and failed for ever: **3 657 error lines in one hour** on `dev.canari-emse.fr`
 * on 2026-09-09, while a member creating a post got a 500 from `POST /api/posts`. Every other
 * service on that estate had the variable; only this one did not.
 *
 * The error line was ALREADY good - it was rewritten on 2026-09-02 to name the destination, after
 * exactly this failure on a local stack with no `REDIS_URL`. It still took a person hitting the bug,
 * because a log that has been shouting since startup is a log nobody reads. What was missing is a
 * line that fires ONCE and names the CAUSE rather than the symptom.
 *
 * A fallback is a signal, never a path. These pin that it says so.
 */
describe('RedisService - choosing the default accuses', () => {
  const original = process.env.REDIS_URL;
  let error: jest.SpyInstance;
  let service: RedisService | undefined;

  beforeEach(() => {
    // Spied on the prototype: the logger is constructed inside the service, so there is no
    // instance to reach before the constructor has already logged.
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    // ioredis connects eagerly, so an un-quit client leaves a handle open and jest force-exits.
    if (service) await service.onModuleDestroy().catch(() => undefined);
    service = undefined;
    jest.restoreAllMocks();
    if (original === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = original;
  });

  it('says WHICH variable is missing and WHERE it fell back to, once, at startup', () => {
    delete process.env.REDIS_URL;

    service = new RedisService();

    expect(error).toHaveBeenCalledTimes(1);
    const said = String(error.mock.calls[0][0]);
    // The variable name, so the reader knows what to set - the repeating connection error names
    // only the address, which is the symptom.
    expect(said).toContain('REDIS_URL');
    expect(said).toContain('redis://localhost:6379');
    // And the consequence, because "cannot connect" does not tell an operator what stops working.
    expect(said).toMatch(/real-time|gateway/i);
  });

  it('stays silent when the variable is set, so the line means something when it appears', () => {
    process.env.REDIS_URL = 'redis://redis:6379';

    service = new RedisService();

    expect(error).not.toHaveBeenCalled();
  });

  it('keeps the default rather than refusing to start, because a laptop outside compose is real', () => {
    delete process.env.REDIS_URL;

    // A hard failure here would break running the service directly on a workstation, which is a
    // supported workflow. The estate defect is fixed where it belongs - in the dev compose - and
    // this branch exists to make the guess audible, not to remove it.
    expect(() => {
      service = new RedisService();
    }).not.toThrow();
  });
});

/**
 * THE ROSTER'S PRESENCE, READ IN ONE PASS (Graine repair, 2026-09-26).
 *
 * A seed request addressed to an offline member is a transport frame nobody receives, and on
 * production every request of a returning member went to one. The election needs to know who is
 * online, and the gateway's presence keys are per DEVICE - so a user is online when ANY key under
 * their prefix exists.
 */
describe('RedisService.onlineUserIds', () => {
  const original = process.env.REDIS_URL;
  let service: RedisService;
  let scan: jest.Mock;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    process.env.REDIS_URL = 'redis://redis:6379';
    service = new RedisService();
    scan = jest.fn();
    // ioredis dials eagerly: the real client is closed, so no handle outlives the test, and replaced
    // before any command is issued.
    const holder = service as unknown as {
      client: { scan: jest.Mock; quit: () => Promise<void>; disconnect?: () => void };
    };
    holder.client.disconnect?.();
    holder.client = {
      scan,
      quit: () => Promise.resolve(),
    };
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (original === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = original;
  });

  it('names a user online when any one of their devices is, across every page of the scan', async () => {
    scan
      .mockResolvedValueOnce(['7', ['user:online:alice:phone', 'user:online:carol:web']])
      .mockResolvedValueOnce(['0', ['user:online:ALICE:laptop', 'user:online:dave:web']]);

    const online = await service.onlineUserIds(['Alice', 'bob', 'dave']);

    // bob has no key, carol is not on the roster asked about.
    expect([...online].sort()).toEqual(['alice', 'dave']);
    expect(scan).toHaveBeenCalledTimes(2);
    expect(scan.mock.calls[1][0]).toBe('7');
  });

  it('does not scan for an empty roster', async () => {
    expect((await service.onlineUserIds([])).size).toBe(0);
    expect(scan).not.toHaveBeenCalled();
  });

  it('throws on a Redis failure rather than calling everyone offline', async () => {
    scan.mockRejectedValue(new Error('timeout'));
    await expect(service.onlineUserIds(['alice'])).rejects.toThrow('timeout');
  });
});
