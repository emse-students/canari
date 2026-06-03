import { PlatformService } from './platform.service';
import type { PlatformConfig } from './entities/platform-config.entity';
import type { Repository } from 'typeorm';

describe('PlatformService', () => {
  let service: PlatformService;
  let repo: jest.Mocked<
    Pick<Repository<PlatformConfig>, 'findOne' | 'findOneOrFail' | 'save'>
  >;

  beforeEach(() => {
    repo = {
      findOne: jest.fn(),
      findOneOrFail: jest.fn(),
      save: jest.fn(),
    };
    service = new PlatformService(
      repo as unknown as Repository<PlatformConfig>,
    );
  });

  it('isAccessBlockedByMaintenance blocks non-admins when enabled', () => {
    const config = {
      maintenanceEnabled: true,
      maintenanceMessage: 'Pause',
      minClientVersion: '1.0.0',
    };
    expect(service.isAccessBlockedByMaintenance(config, false)).toBe(true);
    expect(service.isAccessBlockedByMaintenance(config, true)).toBe(false);
  });

  it('isAccessBlockedByMaintenance allows everyone when disabled', () => {
    const config = {
      maintenanceEnabled: false,
      maintenanceMessage: null,
      minClientVersion: '0.0.0',
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
    });

    await service.ensureDefaults();

    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1, maintenanceEnabled: false }),
    );
  });
});
