import { BadGatewayException, BadRequestException, Logger } from '@nestjs/common';
import { PlatformService, PLATFORM_ERROR_CODES } from './platform.service';
import type { PlatformConfig } from './entities/platform-config.entity';
import type { Repository } from 'typeorm';
import { deployedVersion } from './deployed-version';
import axios from 'axios';

jest.mock('axios');
const mockedAxios = axios as unknown as { post: jest.Mock };

// The bound reads the build's OWN version off disk, which a unit test has no business depending on.
jest.mock('./deployed-version', () => ({ deployedVersion: jest.fn() }));
const mockDeployed = deployedVersion as jest.MockedFunction<typeof deployedVersion>;
/** The acting administrator: a uuid whose first 8 characters are what the audit lines print. */
const ADMIN = 'aaaaaaaa-1111-4111-8111-111111111111';

describe('PlatformService', () => {
  let service: PlatformService;
  let repo: jest.Mocked<
    Pick<Repository<PlatformConfig>, 'findOne' | 'findOneOrFail' | 'save' | 'update'>
  >;

  beforeEach(() => {
    mockedAxios.post.mockReset();
    mockedAxios.post.mockResolvedValue({ data: { released: 0, failed: 0 } });
    repo = {
      findOne: jest.fn(),
      findOneOrFail: jest.fn(),
      save: jest.fn(),
      // A config write is ONE column update of the row: applied to the row the reads answer.
      update: jest.fn(async (_where: unknown, patch: unknown) => {
        const row = await repo.findOneOrFail({ where: { id: 1 } });
        Object.assign(row, patch);
        return { affected: 1, raw: [], generatedMaps: [] };
      }) as never,
    };
    service = new PlatformService(repo as unknown as Repository<PlatformConfig>);
  });

  it('isAccessBlockedByMaintenance blocks non-admins when enabled', () => {
    const config = {
      maintenanceEnabled: true,
      maintenanceMessage: 'Pause',
      minClientVersion: '1.0.0',
      paymentProvider: 'lydia' as const,
      callsMode: 'off' as const,
      livesMode: 'off' as const,
      pushMode: 'full' as const,
    };
    expect(service.isAccessBlockedByMaintenance(config, false)).toBe(true);
    expect(service.isAccessBlockedByMaintenance(config, true)).toBe(false);
  });

  it('isAccessBlockedByMaintenance allows everyone when disabled', () => {
    const config = {
      maintenanceEnabled: false,
      maintenanceMessage: null,
      minClientVersion: '0.0.0',
      paymentProvider: 'lydia' as const,
      callsMode: 'off' as const,
      livesMode: 'off' as const,
      pushMode: 'full' as const,
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
      paymentProvider: 'lydia',
      callsMode: 'off',
      livesMode: 'off',
      pushMode: 'full',
    });

    await service.ensureDefaults();

    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1, maintenanceEnabled: false })
    );
  });

  it('ensureDefaults creates the row with calls OFF - a fresh estate never opens calls by itself', async () => {
    repo.findOne.mockResolvedValue(null);
    repo.save.mockImplementation(async (row) => row as PlatformConfig);

    await service.ensureDefaults();

    expect(repo.save).toHaveBeenCalledWith(expect.objectContaining({ callsMode: 'off' }));
  });

  it('ensureDefaults creates the row with lives OFF - a fresh estate never opens lives by itself', async () => {
    repo.findOne.mockResolvedValue(null);
    repo.save.mockImplementation(async (row) => row as PlatformConfig);

    await service.ensureDefaults();

    expect(repo.save).toHaveBeenCalledWith(expect.objectContaining({ livesMode: 'off' }));
  });

  /** A config row with `minClientVersion` at `min`, wired into the repo mock. */
  const rowWithMin = (min: string): PlatformConfig => {
    const existing: PlatformConfig = {
      id: 1,
      maintenanceEnabled: false,
      maintenanceMessage: null,
      minClientVersion: min,
      paymentProvider: 'lydia',
      callsMode: 'off',
      livesMode: 'off',
      pushMode: 'full',
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
    await expect(service.updateConfig({ minClientVersion: '1.14.1' }, ADMIN)).rejects.toThrow(
      /above this server's own version 0\.14\.1/
    );
    expect(repo.save).not.toHaveBeenCalled();
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('updateConfig accepts a minClientVersion equal to the deployed version', async () => {
    rowWithMin('0.14.0');
    mockDeployed.mockReturnValue('0.14.1');

    const result = await service.updateConfig({ minClientVersion: '0.14.1' }, ADMIN);

    expect(result.minClientVersion).toBe('0.14.1');
  });

  it('updateConfig allows the raise when the deployed version is UNKNOWN', async () => {
    rowWithMin('0.14.0');
    // Not `'0.0.0'` - null is the failed read, and refusing every raise because a file could not be
    // read would be a read failure masquerading as a policy.
    mockDeployed.mockReturnValue(null);

    const result = await service.updateConfig({ minClientVersion: '9.9.9' }, ADMIN);

    expect(result.minClientVersion).toBe('9.9.9');
  });

  describe('turning payments on releases the withheld products', () => {
    const rowWith = (provider: 'lydia' | 'disabled') => {
      const existing: PlatformConfig = {
        id: 1,
        maintenanceEnabled: false,
        maintenanceMessage: null,
        minClientVersion: '0.13.0',
        paymentProvider: provider,
        callsMode: 'off',
        livesMode: 'off',
        pushMode: 'full',
      };
      repo.findOne.mockResolvedValue(existing);
      repo.findOneOrFail.mockResolvedValue(existing);
      repo.save.mockImplementation(async (row) => row as PlatformConfig);
    };

    it('asks social-service to release once the provider is saved as active', async () => {
      rowWith('disabled');
      await service.updateConfig({ paymentProvider: 'lydia' }, ADMIN);
      expect(mockedAxios.post).toHaveBeenCalledTimes(1);
      expect(mockedAxios.post.mock.calls[0][0]).toMatch(/internal\/payments\/provider-activated$/);
      // The release reads the provider back from core, so it must come after the save.
      expect((repo.update as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
        mockedAxios.post.mock.invocationCallOrder[0]
      );
    });

    it('CONTROL: switching to disabled, or not touching the provider, releases nothing', async () => {
      rowWith('lydia');
      await service.updateConfig({ paymentProvider: 'disabled' }, ADMIN);
      await service.updateConfig({ maintenanceEnabled: true }, ADMIN);
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it('bounds the call to social-service with a timeout', async () => {
      rowWith('disabled');
      await service.updateConfig({ paymentProvider: 'lydia' }, ADMIN);
      expect(mockedAxios.post.mock.calls[0][2]).toEqual(
        expect.objectContaining({ timeout: 15_000 })
      );
    });

    /** The 502 body, read the way Nest serialises it. */
    async function refusalOf(p: Promise<unknown>): Promise<Record<string, unknown>> {
      const err = await p.then(
        () => {
          throw new Error('expected a refusal');
        },
        (e: unknown) => e
      );
      expect(err).toBeInstanceOf(BadGatewayException);
      return (err as BadGatewayException).getResponse() as Record<string, unknown>;
    }

    it('answers a failed release with the TYPED code and the saved config, not a generic failure', async () => {
      rowWith('disabled');
      mockedAxios.post.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
      const body = await refusalOf(service.updateConfig({ paymentProvider: 'lydia' }, ADMIN));
      expect(body.code).toBe(PLATFORM_ERROR_CODES.WITHHELD_RELEASE_INCOMPLETE);
      // The provider IS saved, and the body says so.
      expect((body.config as { paymentProvider: string }).paymentProvider).toBe('lydia');
    });

    it('surfaces a partial sweep (failed > 0) with the same code', async () => {
      rowWith('disabled');
      mockedAxios.post.mockResolvedValueOnce({ data: { released: 1, failed: 1 } });
      const body = await refusalOf(service.updateConfig({ paymentProvider: 'lydia' }, ADMIN));
      expect(body.code).toBe(PLATFORM_ERROR_CODES.WITHHELD_RELEASE_INCOMPLETE);
    });
  });

  describe('the explicit release action (the retry that does not depend on the form diff)', () => {
    const rowWith = (provider: 'lydia' | 'disabled') => {
      const existing: PlatformConfig = {
        id: 1,
        maintenanceEnabled: false,
        maintenanceMessage: null,
        minClientVersion: '0.13.0',
        paymentProvider: provider,
        callsMode: 'off',
        livesMode: 'off',
        pushMode: 'full',
      };
      repo.findOne.mockResolvedValue(existing);
      repo.findOneOrFail.mockResolvedValue(existing);
    };

    it('runs the sweep when a provider is active, and answers its counts', async () => {
      rowWith('lydia');
      mockedAxios.post.mockResolvedValueOnce({ data: { released: 4, failed: 0 } });
      await expect(service.releaseWithheldProducts(ADMIN)).resolves.toEqual({
        released: 4,
        failed: 0,
      });
      expect(mockedAxios.post.mock.calls[0][0]).toMatch(/internal\/payments\/provider-activated$/);
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('CONTROL: refuses with PAYMENTS_DISABLED and calls nothing while payments are off', async () => {
      rowWith('disabled');
      const err = await service.releaseWithheldProducts(ADMIN).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(((err as BadRequestException).getResponse() as { code: string }).code).toBe(
        PLATFORM_ERROR_CODES.PAYMENTS_DISABLED
      );
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it('answers WITHHELD_RELEASE_INCOMPLETE when the sweep misses some again', async () => {
      rowWith('lydia');
      mockedAxios.post.mockResolvedValueOnce({ data: { released: 0, failed: 2 } });
      const err = await service.releaseWithheldProducts(ADMIN).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadGatewayException);
      expect(((err as BadGatewayException).getResponse() as { code: string }).code).toBe(
        PLATFORM_ERROR_CODES.WITHHELD_RELEASE_INCOMPLETE
      );
    });
  });

  it('updateConfig writes only the columns it names, never a save of the row read', async () => {
    rowWithMin('0.13.0');
    await service.updateConfig({ callsMode: 'audio', maintenanceEnabled: true }, ADMIN);
    expect(repo.update).toHaveBeenCalledWith(
      { id: 1 },
      { callsMode: 'audio', maintenanceEnabled: true }
    );
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('updateConfig switches paymentProvider and leaves other fields untouched', async () => {
    const existing: PlatformConfig = {
      id: 1,
      maintenanceEnabled: false,
      maintenanceMessage: null,
      minClientVersion: '0.13.0',
      paymentProvider: 'lydia',
      callsMode: 'off',
      livesMode: 'off',
      pushMode: 'full',
    };
    repo.findOne.mockResolvedValue(existing);
    repo.findOneOrFail.mockResolvedValue(existing);
    repo.save.mockImplementation(async (row) => row as PlatformConfig);

    const result = await service.updateConfig({ paymentProvider: 'lydia' }, ADMIN);

    expect(result.paymentProvider).toBe('lydia');
    expect(result.minClientVersion).toBe('0.13.0');
  });

  it('updateConfig stores the third value, disabled, without touching other fields', async () => {
    const existing: PlatformConfig = {
      id: 1,
      maintenanceEnabled: false,
      maintenanceMessage: null,
      minClientVersion: '0.13.0',
      paymentProvider: 'lydia',
      callsMode: 'off',
      livesMode: 'off',
      pushMode: 'full',
    };
    repo.findOne.mockResolvedValue(existing);
    repo.findOneOrFail.mockResolvedValue(existing);
    repo.save.mockImplementation(async (row) => row as PlatformConfig);

    const result = await service.updateConfig({ paymentProvider: 'disabled' }, ADMIN);

    expect(result.paymentProvider).toBe('disabled');
    expect(result.minClientVersion).toBe('0.13.0');
  });

  it('updateConfig moves the calls kill switch, logs it at warn, and touches nothing else', async () => {
    const existing = rowWithMin('0.13.0');
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    const result = await service.updateConfig({ callsMode: 'audio' }, ADMIN);

    expect(result.callsMode).toBe('audio');
    expect(result.minClientVersion).toBe('0.13.0');
    expect(result.paymentProvider).toBe(existing.paymentProvider);
    expect(warn.mock.calls.map((c) => String(c[0]))).toContain(
      'callsMode off -> audio by=aaaaaaaa'
    );
    warn.mockRestore();
  });

  it('updateConfig leaves the calls mode alone when the update does not name it', async () => {
    const existing = rowWithMin('0.13.0');
    existing.callsMode = 'audio_video';

    const result = await service.updateConfig({ maintenanceEnabled: true }, ADMIN);

    expect(result.callsMode).toBe('audio_video');
  });

  it('updateConfig moves the lives kill switch, logs it at warn with the actor, and touches nothing else', async () => {
    const existing = rowWithMin('0.13.0');
    existing.callsMode = 'audio';
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    const result = await service.updateConfig({ livesMode: 'on' }, ADMIN);

    expect(result.livesMode).toBe('on');
    expect(result.callsMode).toBe('audio');
    expect(result.minClientVersion).toBe('0.13.0');
    expect(warn.mock.calls.map((c) => String(c[0]))).toContain('livesMode off -> on by=aaaaaaaa');
    warn.mockRestore();
  });

  it('updateConfig moves the push switch, logs it at warn with the actor, and touches nothing else', async () => {
    const existing = rowWithMin('0.13.0');
    existing.livesMode = 'on';
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    const result = await service.updateConfig({ pushMode: 'wake' }, ADMIN);

    expect(result.pushMode).toBe('wake');
    expect(result.livesMode).toBe('on');
    expect(warn.mock.calls.map((c) => String(c[0]))).toContain('pushMode full -> wake by=aaaaaaaa');
    warn.mockRestore();
  });

  it('updateConfig leaves the lives mode alone when the update does not name it', async () => {
    const existing = rowWithMin('0.13.0');
    existing.livesMode = 'on';

    const result = await service.updateConfig({ callsMode: 'off' }, ADMIN);

    expect(result.livesMode).toBe('on');
  });
});
