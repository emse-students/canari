import { BadRequestException, ForbiddenException, Logger } from '@nestjs/common';
import { InternalDistributionEntitlementController } from './internal-distribution-entitlement.controller';
import type { ChannelService } from '../channels/channel.service';

describe('InternalDistributionEntitlementController', () => {
  const env = { ...process.env };
  const distributionGroupEntitlement = jest.fn();
  const controller = new InternalDistributionEntitlementController({
    distributionGroupEntitlement,
  } as unknown as ChannelService);

  beforeEach(() => {
    process.env.INTERNAL_SECRET = 'shared-secret';
    distributionGroupEntitlement.mockReset().mockResolvedValue({ entitled: true });
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
      distributionGroupEntitlement.mockResolvedValue(
        entitled ? { entitled } : { entitled, cause: 'not a reader of the salon' }
      );

      await expect(
        controller.entitlement('shared-secret', {
          kind: 'channel',
          scopeId: 'ch-1',
          userId: 'U-1',
        })
      ).resolves.toEqual({ entitled });
      // The user id is compared as the rest of this service stores it.
      expect(distributionGroupEntitlement).toHaveBeenCalledWith('channel', 'ch-1', 'u-1');
    }
  );

  it('logs the verdict when it CHANGES, not on every read, and names the cause of a flip to false', async () => {
    const log = jest.spyOn(Logger.prototype, 'log');
    const ask = () =>
      controller.entitlement('shared-secret', {
        kind: 'workspace',
        scopeId: 'ws-9',
        userId: 'u-9',
      });
    for (let i = 0; i < 5; i++) await ask();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain('first evaluation');

    distributionGroupEntitlement.mockResolvedValue({
      entitled: false,
      cause: 'not a member of the community',
    });
    await ask();
    await ask();
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[1][0]).toContain(
      'entitled=false (was true) - not a member of the community'
    );
  });

  it('refuses a caller without the internal secret before asking anything', async () => {
    await expect(
      controller.entitlement('wrong', { kind: 'workspace', scopeId: 'ws-1', userId: 'u-1' })
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(distributionGroupEntitlement).not.toHaveBeenCalled();
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
    expect(distributionGroupEntitlement).not.toHaveBeenCalled();
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
