import { PlatformService } from './platform.service';
import type { PlatformConfig } from './entities/platform-config.entity';
import type { Repository } from 'typeorm';

describe('PlatformService', () => {
  let service: PlatformService;
  let repo: jest.Mocked<Pick<Repository<PlatformConfig>, 'findOne' | 'findOneOrFail' | 'save'>>;

  beforeEach(() => {
    repo = {
      findOne: jest.fn(),
      findOneOrFail: jest.fn(),
      save: jest.fn(),
    };
    service = new PlatformService(repo as unknown as Repository<PlatformConfig>);
  });

  it('isAccessBlockedByMaintenance blocks non-admins when enabled', () => {
    const config = {
      maintenanceEnabled: true,
      maintenanceMessage: 'Pause',
      minClientVersion: '1.0.0',
      paymentProvider: 'stripe' as const,
    };
    expect(service.isAccessBlockedByMaintenance(config, false)).toBe(true);
    expect(service.isAccessBlockedByMaintenance(config, true)).toBe(false);
  });

  it('isAccessBlockedByMaintenance allows everyone when disabled', () => {
    const config = {
      maintenanceEnabled: false,
      maintenanceMessage: null,
      minClientVersion: '0.0.0',
      paymentProvider: 'stripe' as const,
    };
    expect(service.isAccessBlockedByMaintenance(config, false)).toBe(false);
    expect(service.isAccessBlockedByMaintenance(config, true)).toBe(false);
  });

  it('ensureDefaults creates row when missing', async () => {
    repo.findOne.mockResolvedValue(null);
    repo.save.mockResolvedValue({
      id: 1,
      maintenanceEnabled: false,
      maintenanceMessage: null,
      minClientVersion: '0.0.0',
      paymentProvider: 'stripe',
    });

    await service.ensureDefaults();

    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1, maintenanceEnabled: false })
    );
  });

  it('updateConfig switches paymentProvider and leaves other fields untouched', async () => {
    const existing: PlatformConfig = {
      id: 1,
      maintenanceEnabled: false,
      maintenanceMessage: null,
      minClientVersion: '0.13.0',
      paymentProvider: 'stripe',
    };
    repo.findOne.mockResolvedValue(existing);
    repo.findOneOrFail.mockResolvedValue(existing);
    repo.save.mockImplementation(async (row) => row as PlatformConfig);

    const result = await service.updateConfig({ paymentProvider: 'lydia' });

    expect(result.paymentProvider).toBe('lydia');
    expect(result.minClientVersion).toBe('0.13.0');
  });
});
