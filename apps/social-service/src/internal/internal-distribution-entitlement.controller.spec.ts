import { BadRequestException, ForbiddenException, Logger } from '@nestjs/common';
import { InternalDistributionEntitlementController } from './internal-distribution-entitlement.controller';
import type { ChannelService } from '../channels/channel.service';

describe('InternalDistributionEntitlementController', () => {
  const env = { ...process.env };
  const isDistributionGroupEntitled = jest.fn();
  const controller = new InternalDistributionEntitlementController({
    isDistributionGroupEntitled,
  } as unknown as ChannelService);

  beforeEach(() => {
    process.env.INTERNAL_SECRET = 'shared-secret';
    isDistributionGroupEntitled.mockReset().mockResolvedValue(true);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    process.env = { ...env };
    jest.restoreAllMocks();
  });

  it.each([true, false])(
    'answers the service verdict (%s) for a well-formed question',
    async (entitled) => {
      isDistributionGroupEntitled.mockResolvedValue(entitled);

      await expect(
        controller.entitlement('shared-secret', { kind: 'channel', scopeId: 'ch-1', userId: 'U-1' })
      ).resolves.toEqual({ entitled });
      // The user id is compared as the rest of this service stores it.
      expect(isDistributionGroupEntitled).toHaveBeenCalledWith('channel', 'ch-1', 'u-1');
    }
  );

  it('refuses a caller without the internal secret before asking anything', async () => {
    await expect(
      controller.entitlement('wrong', { kind: 'workspace', scopeId: 'ws-1', userId: 'u-1' })
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(isDistributionGroupEntitled).not.toHaveBeenCalled();
  });

  it('refuses a malformed question rather than answering it', async () => {
    for (const bad of [
      { kind: 'salon', scopeId: 'ch-1', userId: 'u-1' },
      { kind: 'workspace', scopeId: '', userId: 'u-1' },
      { kind: 'workspace', scopeId: 'ws-1', userId: '  ' },
    ]) {
      await expect(
        controller.entitlement('shared-secret', bad as Parameters<typeof controller.entitlement>[1])
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(isDistributionGroupEntitled).not.toHaveBeenCalled();
  });

  describe('departure-outcome', () => {
    const GROUP = '11111111-2222-4333-8444-555555555555';
    const decideDistributionDeparture = jest.fn();
    const outcomes = new InternalDistributionEntitlementController({
      decideDistributionDeparture,
    } as unknown as ChannelService);

    beforeEach(() => decideDistributionDeparture.mockReset().mockResolvedValue('cancelled'));

    it('answers the outcome the service decides, for the person exactly as named', async () => {
      await expect(
        outcomes.departureOutcome('shared-secret', { groupId: GROUP, userId: 'u-1', departure: 3 })
      ).resolves.toEqual({ outcome: 'cancelled' });
      expect(decideDistributionDeparture).toHaveBeenCalledWith(GROUP, 'u-1', 3);
    });

    it('refuses a caller without the internal secret before deciding anything', async () => {
      await expect(
        outcomes.departureOutcome('wrong', { groupId: GROUP, userId: 'u-1', departure: 3 })
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(decideDistributionDeparture).not.toHaveBeenCalled();
    });

    it('refuses a malformed question rather than deciding it', async () => {
      for (const bad of [
        { groupId: 'not-a-uuid', userId: 'u-1', departure: 3 },
        { groupId: GROUP, userId: '', departure: 3 },
        { groupId: GROUP, userId: 'u-1', departure: 0 },
        { groupId: GROUP, userId: 'u-1', departure: '3' },
      ]) {
        await expect(outcomes.departureOutcome('shared-secret', bad)).rejects.toBeInstanceOf(
          BadRequestException
        );
      }
      expect(decideDistributionDeparture).not.toHaveBeenCalled();
    });
  });
});
