import { PlatformService } from './platform.service';
import type { PlatformConfig } from './entities/platform-config.entity';
import type { Repository } from 'typeorm';
import { deployedVersion } from './deployed-version';

// The bound reads the build's OWN version off disk, which a unit test has no business depending on.
jest.mock('./deployed-version', () => ({ deployedVersion: jest.fn() }));
const mockDeployed = deployedVersion as jest.MockedFunction<typeof deployedVersion>;

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

  /** A config row with `minClientVersion` at `min`, wired into the repo mock. */
  const rowWithMin = (min: string): PlatformConfig => {
    const existing: PlatformConfig = {
      id: 1,
      maintenanceEnabled: false,
      maintenanceMessage: null,
      minClientVersion: min,
      paymentProvider: 'stripe',
    };
    repo.findOne.mockResolvedValue(existing);
    repo.findOneOrFail.mockResolvedValue(existing);
    repo.save.mockImplementation(async (row) => row as PlatformConfig);
    return existing;
  };

  it('updateConfig refuses a minClientVersion above the deployed version', async () => {
    rowWithMin('0.14.0');
    mockDeployed.mockReturnValue('0.14.1');

    // One keystroke from `0.14.1`, well-formed, and satisfiable by no client that exists.
    await expect(service.updateConfig({ minClientVersion: '1.14.1' })).rejects.toThrow(
      /above this server's own version 0\.14\.1/
    );
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('updateConfig accepts a minClientVersion equal to the deployed version', async () => {
    rowWithMin('0.14.0');
    mockDeployed.mockReturnValue('0.14.1');

    const result = await service.updateConfig({ minClientVersion: '0.14.1' });

    expect(result.minClientVersion).toBe('0.14.1');
  });

  it('updateConfig allows the raise when the deployed version is UNKNOWN', async () => {
    rowWithMin('0.14.0');
    // Not `'0.0.0'` - null is the failed read, and refusing every raise because a file could not be
    // read would be a read failure masquerading as a policy.
    mockDeployed.mockReturnValue(null);

    const result = await service.updateConfig({ minClientVersion: '9.9.9' });

    expect(result.minClientVersion).toBe('9.9.9');
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
