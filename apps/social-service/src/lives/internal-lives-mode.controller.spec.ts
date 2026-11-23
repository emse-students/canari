import { HttpStatus, Logger } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import type { DataSource } from 'typeorm';
import { InternalLivesModeController } from './internal-lives-mode.controller';

/**
 * The relay of the lives kill switch to media-service: the raw mode, behind the internal secret,
 * and never behind the switch it reports.
 */
describe('InternalLivesModeController', () => {
  const saved = process.env.INTERNAL_SECRET;
  beforeAll(() => {
    process.env.INTERNAL_SECRET = 'the-secret';
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.INTERNAL_SECRET;
    else process.env.INTERNAL_SECRET = saved;
  });

  const controllerOver = (rows: unknown[]) => {
    const query = jest.fn().mockResolvedValue(rows);
    return {
      controller: new InternalLivesModeController({ manager: { query } } as unknown as DataSource),
      query,
    };
  };

  it.each(['off', 'on'])('answers the mode the database holds: %s', async (mode) => {
    const { controller } = controllerOver([{ lives_mode: mode }]);
    await expect(controller.mode('the-secret')).resolves.toEqual({ mode });
  });

  it('logs the relayed mode when it changes, never once per request', async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const debug = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    try {
      const rows = [{ lives_mode: 'on' }];
      const { controller } = controllerOver(rows);
      for (let i = 0; i < 5; i++) await controller.mode('the-secret');
      expect(log).toHaveBeenCalledTimes(1);
      rows[0] = { lives_mode: 'off' };
      for (let i = 0; i < 5; i++) await controller.mode('the-secret');
      expect(log).toHaveBeenCalledTimes(2);
      expect(log.mock.calls[1][0]).toContain('off (previously on)');
      expect(debug).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      debug.mockRestore();
    }
  });

  it('refuses a caller without the secret, before reading anything', async () => {
    const { controller, query } = controllerOver([{ lives_mode: 'on' }]);
    for (const secret of [undefined, '', 'wrong-secret']) {
      await expect(controller.mode(secret)).rejects.toMatchObject({
        status: HttpStatus.FORBIDDEN,
      });
    }
    expect(query).not.toHaveBeenCalled();
  });

  it('throws on an unknown value rather than relaying it', async () => {
    const { controller } = controllerOver([{ lives_mode: 'maybe' }]);
    await expect(controller.mode('the-secret')).rejects.toThrow(/unknown value/);
  });

  it('is not behind the switch it reports', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, InternalLivesModeController)).toBeUndefined();
  });
});
