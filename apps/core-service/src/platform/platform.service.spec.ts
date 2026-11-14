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
      checkpointSkipMode: 'off' as const,
      liveReplaysMode: 'off' as const,
      groupCallsMode: 'off' as const,
      callRelay: 'none' as const,
      retentionReelDays: 365,
      retentionLiveReplayDays: 3,
      retentionChatReelDays: 30,
      retentionIdleMediaDays: 90,
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
      checkpointSkipMode: 'off' as const,
      liveReplaysMode: 'off' as const,
      groupCallsMode: 'off' as const,
      callRelay: 'none' as const,
      retentionReelDays: 365,
      retentionLiveReplayDays: 3,
      retentionChatReelDays: 30,
      retentionIdleMediaDays: 90,
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
      checkpointSkipMode: 'off',
      liveReplaysMode: 'off',
      groupCallsMode: 'off',
      callRelay: 'none',
      lydiaContractAnniversary: null,
      lydiaContract: null,
      retentionReelDays: 365,
      retentionLiveReplayDays: 3,
      retentionChatReelDays: 30,
      retentionIdleMediaDays: 90,
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

  it('ensureDefaults creates the row with the checkpoint skip OFF - every drain checkpoints until an admin says otherwise', async () => {
    repo.findOne.mockResolvedValue(null);
    repo.save.mockImplementation(async (row) => row as PlatformConfig);

    await service.ensureDefaults();

    expect(repo.save).toHaveBeenCalledWith(expect.objectContaining({ checkpointSkipMode: 'off' }));
  });

  it('ensureDefaults creates the row with live replays OFF - every live is deleted at its end until an admin says otherwise', async () => {
    repo.findOne.mockResolvedValue(null);
    repo.save.mockImplementation(async (row) => row as PlatformConfig);

    await service.ensureDefaults();

    expect(repo.save).toHaveBeenCalledWith(expect.objectContaining({ liveReplaysMode: 'off' }));
  });

  it('ensureDefaults creates the row with group calls OFF - no group call may start until an admin says otherwise', async () => {
    repo.findOne.mockResolvedValue(null);
    repo.save.mockImplementation(async (row) => row as PlatformConfig);

    await service.ensureDefaults();

    expect(repo.save).toHaveBeenCalledWith(expect.objectContaining({ groupCallsMode: 'off' }));
  });

  it('ensureDefaults creates the row with NO relay - a group call stays a mesh until an admin says otherwise', async () => {
    repo.findOne.mockResolvedValue(null);
    repo.save.mockImplementation(async (row) => row as PlatformConfig);

    await service.ensureDefaults();

    expect(repo.save).toHaveBeenCalledWith(expect.objectContaining({ callRelay: 'none' }));
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
      checkpointSkipMode: 'off',
      liveReplaysMode: 'off',
      groupCallsMode: 'off',
      callRelay: 'none',
      lydiaContractAnniversary: null,
      lydiaContract: null,
      retentionReelDays: 365,
      retentionLiveReplayDays: 3,
      retentionChatReelDays: 30,
      retentionIdleMediaDays: 90,
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
        checkpointSkipMode: 'off',
        liveReplaysMode: 'off',
        groupCallsMode: 'off',
        callRelay: 'none',
        lydiaContractAnniversary: null,
        lydiaContract: null,
        retentionReelDays: 365,
        retentionLiveReplayDays: 3,
        retentionChatReelDays: 30,
        retentionIdleMediaDays: 90,
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
        checkpointSkipMode: 'off',
        liveReplaysMode: 'off',
        groupCallsMode: 'off',
        callRelay: 'none',
        lydiaContractAnniversary: null,
        lydiaContract: null,
        retentionReelDays: 365,
        retentionLiveReplayDays: 3,
        retentionChatReelDays: 30,
        retentionIdleMediaDays: 90,
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
      checkpointSkipMode: 'off',
      liveReplaysMode: 'off',
      groupCallsMode: 'off',
      callRelay: 'none',
      lydiaContractAnniversary: null,
      lydiaContract: null,
      retentionReelDays: 365,
      retentionLiveReplayDays: 3,
      retentionChatReelDays: 30,
      retentionIdleMediaDays: 90,
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
      checkpointSkipMode: 'off',
      liveReplaysMode: 'off',
      groupCallsMode: 'off',
      callRelay: 'none',
      lydiaContractAnniversary: null,
      lydiaContract: null,
      retentionReelDays: 365,
      retentionLiveReplayDays: 3,
      retentionChatReelDays: 30,
      retentionIdleMediaDays: 90,
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

  it('updateConfig moves the checkpoint-skip switch, logs it at warn with the actor, and touches nothing else', async () => {
    const existing = rowWithMin('0.13.0');
    existing.pushMode = 'wake';
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    const result = await service.updateConfig({ checkpointSkipMode: 'on' }, ADMIN);

    expect(result.checkpointSkipMode).toBe('on');
    expect(result.pushMode).toBe('wake');
    expect(repo.update).toHaveBeenCalledWith({ id: 1 }, { checkpointSkipMode: 'on' });
    expect(warn.mock.calls.map((c) => String(c[0]))).toContain(
      'checkpointSkipMode off -> on by=aaaaaaaa'
    );
    warn.mockRestore();
  });

  it('updateConfig moves the live replays switch, logs it at warn with the actor, and touches nothing else', async () => {
    const existing = rowWithMin('0.13.0');
    existing.livesMode = 'on';
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    const result = await service.updateConfig({ liveReplaysMode: 'on' }, ADMIN);

    expect(result.liveReplaysMode).toBe('on');
    expect(result.livesMode).toBe('on');
    expect(repo.update).toHaveBeenCalledWith({ id: 1 }, { liveReplaysMode: 'on' });
    expect(warn.mock.calls.map((c) => String(c[0]))).toContain(
      'liveReplaysMode off -> on by=aaaaaaaa'
    );
    warn.mockRestore();
  });

  it('updateConfig moves the group calls switch, logs it at warn with the actor, and touches nothing else', async () => {
    const existing = rowWithMin('0.13.0');
    existing.callsMode = 'audio_video';
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    const result = await service.updateConfig({ groupCallsMode: 'mesh' }, ADMIN);

    expect(result.groupCallsMode).toBe('mesh');
    expect(result.callsMode).toBe('audio_video');
    expect(repo.update).toHaveBeenCalledWith({ id: 1 }, { groupCallsMode: 'mesh' });
    expect(warn.mock.calls.map((c) => String(c[0]))).toContain(
      'groupCallsMode off -> mesh by=aaaaaaaa'
    );
    warn.mockRestore();
  });

  it('updateConfig moves the call relay, logs it at warn with the actor, and touches nothing else', async () => {
    const existing = rowWithMin('0.13.0');
    existing.groupCallsMode = 'mesh';
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    const result = await service.updateConfig({ callRelay: 'call-service' }, ADMIN);

    expect(result.callRelay).toBe('call-service');
    expect(result.groupCallsMode).toBe('mesh');
    expect(repo.update).toHaveBeenCalledWith({ id: 1 }, { callRelay: 'call-service' });
    expect(warn.mock.calls.map((c) => String(c[0]))).toContain(
      'callRelay none -> call-service by=aaaaaaaa'
    );
    warn.mockRestore();
  });

  it('updateConfig moves a retention duration, logs it at warn with the actor, and touches nothing else', async () => {
    rowWithMin('0.13.0');
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await service.updateConfig({ retentionReelDays: 180 }, ADMIN);

    expect(repo.update).toHaveBeenCalledWith({ id: 1 }, { retentionReelDays: 180 });
    expect(warn.mock.calls.map((c) => String(c[0]))).toContain(
      'retentionReelDays 365 -> 180 days by=aaaaaaaa'
    );
    warn.mockRestore();
  });

  it('getConfig publishes every retention duration the row holds', async () => {
    const row = rowWithMin('0.13.0');
    row.retentionChatReelDays = 14;
    const config = await service.getConfig();
    expect(config).toMatchObject({
      retentionReelDays: 365,
      retentionLiveReplayDays: 3,
      retentionChatReelDays: 14,
      retentionIdleMediaDays: 90,
    });
  });

  it('updateConfig leaves the lives mode alone when the update does not name it', async () => {
    const existing = rowWithMin('0.13.0');
    existing.livesMode = 'on';

    const result = await service.updateConfig({ callsMode: 'off' }, ADMIN);

    expect(result.livesMode).toBe('on');
  });

  describe('getConfig - one query, one read in flight', () => {
    it('reads the existing row with ONE query, never ensureDefaults first', async () => {
      rowWithMin('1.6.6');
      const config = await service.getConfig();
      expect(config.minClientVersion).toBe('1.6.6');
      expect(repo.findOne).toHaveBeenCalledTimes(1);
      expect(repo.findOneOrFail).not.toHaveBeenCalled();
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('writes the defaults only when no row exists yet', async () => {
      const row = rowWithMin('0.0.0');
      repo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
      const config = await service.getConfig();
      expect(repo.save).toHaveBeenCalledTimes(1);
      expect(config.minClientVersion).toBe(row.minClientVersion);
    });

    it('concurrent callers share one read, and a later caller reads afresh', async () => {
      rowWithMin('1.6.6');
      const [a, b] = await Promise.all([service.getConfig(), service.getConfig()]);
      expect(a).toEqual(b);
      expect(repo.findOne).toHaveBeenCalledTimes(1);
      await service.getConfig();
      expect(repo.findOne).toHaveBeenCalledTimes(2);
    });

    it('a write drops the read in flight: a caller after the write never joins the older read', async () => {
      const row = rowWithMin('1.6.6');
      // The first read is HELD OPEN across the whole write, so only the write's clear can stop the
      // caller after it from joining that read.
      let releaseFirst: (value: typeof row) => void = () => undefined;
      repo.findOne.mockImplementationOnce(
        () => new Promise((resolve) => (releaseFirst = resolve)) as never
      );
      const before = service.getConfig();
      mockDeployed.mockReturnValue('1.6.9');
      await service.updateConfig({ minClientVersion: '1.6.8' }, ADMIN);

      const readsBefore = repo.findOne.mock.calls.length;
      const after = service.getConfig();
      expect(repo.findOne.mock.calls.length).toBe(readsBefore + 1);
      expect(after).not.toBe(before);
      expect((await after).minClientVersion).toBe('1.6.8');

      releaseFirst(row);
      await before;
    });

    it('a failed read fails every caller that joined it, and the next call reads again', async () => {
      const row = rowWithMin('1.6.6');
      repo.findOne.mockRejectedValueOnce(new Error('connection reset'));
      const results = await Promise.allSettled([service.getConfig(), service.getConfig()]);
      expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
      expect(repo.findOne).toHaveBeenCalledTimes(1);

      // Dropped on the failure too, not only on a success: the next caller is not handed it.
      await expect(service.getConfig()).resolves.toMatchObject({
        minClientVersion: row.minClientVersion,
      });
      expect(repo.findOne).toHaveBeenCalledTimes(2);
    });
  });
});
