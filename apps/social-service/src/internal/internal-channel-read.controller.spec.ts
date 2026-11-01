import { BadRequestException, ForbiddenException, Logger } from '@nestjs/common';
import { InternalChannelReadController } from './internal-channel-read.controller';
import type { ChannelService } from '../channels/channel.service';

describe('InternalChannelReadController', () => {
  const env = { ...process.env };
  const advanceChannelReadMark = jest.fn();
  const markChannelRead = jest.fn();
  const isReaderOfChannel = jest.fn();
  const controller = new InternalChannelReadController({
    advanceChannelReadMark,
    markChannelRead,
    isReaderOfChannel,
  } as unknown as ChannelService);

  beforeEach(() => {
    process.env.INTERNAL_SECRET = 'shared-secret';
    advanceChannelReadMark.mockReset().mockResolvedValue({ at: 1_700_000_000_000 });
    markChannelRead.mockReset().mockResolvedValue(undefined);
    isReaderOfChannel.mockReset();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    process.env = { ...env };
    jest.restoreAllMocks();
  });

  const body = { userId: 'U-1', at: 1_700_000_000_000 };

  it('raises the read receipt to the notification instant, then fans the clear-banner push out', async () => {
    const out = await controller.read('shared-secret', 'chan-1', body);
    expect(advanceChannelReadMark).toHaveBeenCalledWith(
      'chan-1',
      'u-1',
      1_700_000_000_000,
      1_700_000_000_000
    );
    expect(markChannelRead).toHaveBeenCalledWith('chan-1', 'u-1');
    expect(out).toEqual({ at: 1_700_000_000_000 });
  });

  it('answers null when the mark did not move, and still clears the sibling banners', async () => {
    advanceChannelReadMark.mockResolvedValue(null);
    await expect(controller.read('shared-secret', 'chan-1', body)).resolves.toEqual({ at: null });
    expect(markChannelRead).toHaveBeenCalled();
  });

  it('keeps the durable receipt when the fan-out fails, and logs it', async () => {
    markChannelRead.mockRejectedValue(new Error('push down'));
    const warn = jest.spyOn(Logger.prototype, 'warn');
    await expect(controller.read('shared-secret', 'chan-1', body)).resolves.toEqual({
      at: 1_700_000_000_000,
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('fan-out failed'));
  });

  it('refuses a caller without the internal secret before touching anything', async () => {
    await expect(controller.read('wrong', 'chan-1', body)).rejects.toBeInstanceOf(
      ForbiddenException
    );
    expect(advanceChannelReadMark).not.toHaveBeenCalled();
  });

  it('refuses a missing user or a non-positive or fractional instant', async () => {
    for (const bad of [
      { userId: '', at: 5 },
      { userId: 'u', at: 0 },
      { userId: 'u', at: -3 },
      { userId: 'u', at: 1.5 },
      { userId: 'u', at: '5' as unknown as number },
    ]) {
      await expect(controller.read('shared-secret', 'chan-1', bad)).rejects.toBeInstanceOf(
        BadRequestException
      );
    }
    expect(advanceChannelReadMark).not.toHaveBeenCalled();
  });

  it('lets a membership refusal from the service reach the caller', async () => {
    advanceChannelReadMark.mockRejectedValue(new ForbiddenException('Not allowed'));
    await expect(controller.read('shared-secret', 'chan-1', body)).rejects.toBeInstanceOf(
      ForbiddenException
    );
    expect(markChannelRead).not.toHaveBeenCalled();
  });

  describe('reader - the salon question of mls/notify-reaction', () => {
    const SALON = '11111111-2222-4333-8444-555555555555';

    it('answers true for a reader, asking with the canonical user id', async () => {
      isReaderOfChannel.mockResolvedValue(true);
      await expect(controller.reader('shared-secret', SALON, { userId: ' U-1 ' })).resolves.toEqual(
        { reader: true }
      );
      expect(isReaderOfChannel).toHaveBeenCalledWith(SALON, 'u-1');
    });

    it('answers false for a non-reader, and says so', async () => {
      isReaderOfChannel.mockResolvedValue(false);
      const warn = jest.spyOn(Logger.prototype, 'warn');
      await expect(controller.reader('shared-secret', SALON, { userId: 'u-2' })).resolves.toEqual({
        reader: false,
      });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('is not a reader'));
    });

    it('refuses a caller without the internal secret, and a question with no user', async () => {
      await expect(controller.reader('wrong', SALON, { userId: 'u-1' })).rejects.toBeInstanceOf(
        ForbiddenException
      );
      await expect(controller.reader('shared-secret', SALON, {})).rejects.toBeInstanceOf(
        BadRequestException
      );
      expect(isReaderOfChannel).not.toHaveBeenCalled();
    });
  });
});
