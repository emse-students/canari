import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PlatformConfig } from './entities/platform-config.entity';
import { UpdatePlatformConfigDto } from './dto/update-platform-config.dto';
import { compareSemver } from './semver';
import { deployedVersion } from './deployed-version';

export type PlatformConfigPublic = {
  maintenanceEnabled: boolean;
  maintenanceMessage: string | null;
  minClientVersion: string;
  paymentProvider: 'stripe' | 'lydia';
};

const DEFAULT_ROW: PlatformConfig = {
  id: 1,
  maintenanceEnabled: false,
  maintenanceMessage: null,
  minClientVersion: '0.0.0',
  paymentProvider: 'stripe',
};

/** Reads and updates the singleton platform configuration row in PostgreSQL. */
@Injectable()
export class PlatformService implements OnModuleInit {
  private readonly logger = new Logger(PlatformService.name);

  constructor(
    @InjectRepository(PlatformConfig)
    private readonly repo: Repository<PlatformConfig>
  ) {}

  /** Ensures the singleton config row exists on service startup. */
  async onModuleInit(): Promise<void> {
    await this.ensureDefaults();
  }

  /** Creates the default row when missing (id=1). */
  async ensureDefaults(): Promise<void> {
    const existing = await this.repo.findOne({ where: { id: 1 } });
    if (existing) return;
    this.logger.debug('Creating default platform_config row');
    await this.repo.save({ ...DEFAULT_ROW });
  }

  /** Returns current platform settings for public version endpoint and auth guards. */
  async getConfig(): Promise<PlatformConfigPublic> {
    await this.ensureDefaults();
    const row = await this.repo.findOneOrFail({ where: { id: 1 } });
    return toPublic(row);
  }

  /** Applies a partial update from a global admin and returns the new config. */
  async updateConfig(dto: UpdatePlatformConfigDto): Promise<PlatformConfigPublic> {
    await this.ensureDefaults();
    const row = await this.repo.findOneOrFail({ where: { id: 1 } });

    if (dto.maintenanceEnabled !== undefined) {
      row.maintenanceEnabled = dto.maintenanceEnabled;
    }
    if (dto.maintenanceMessage !== undefined) {
      const trimmed = dto.maintenanceMessage?.trim() ?? '';
      row.maintenanceMessage = trimmed.length > 0 ? trimmed : null;
    }
    if (dto.minClientVersion !== undefined) {
      const wanted = dto.minClientVersion.trim();
      // A CEILING ON THE ONE CONTROL THAT CAN LOCK OUT EVERY CLIENT AT ONCE.
      //
      // The DTO already refuses anything that is not `major.minor.patch`, so the value reaching here
      // is well-formed - and well-formed is not the same as possible. `1.14.0` for `0.14.0` is a
      // single keystroke and demands a client newer than any that has ever been built, which no user
      // can satisfy by updating. Nothing checked it: v0.14.0's raise locked out every iOS user the
      // App Store had not reached (see docs/wiki/legacy-compatibility.md).
      //
      // WHAT THIS CATCHES AND WHAT IT CANNOT. Above the deployed version is always wrong, so it is
      // refused. AT or below is accepted, which does NOT make it safe - the real hazard is a raise
      // above what the app stores have actually shipped, and no server can see App Store review
      // state. This is a typo guard on a platform-wide switch, not a substitute for the shipping
      // order that page describes.
      const deployed = deployedVersion();
      if (deployed === null) {
        // ACCUSING, NOT INFORMATIONAL: the guard did not run, and the next lockout will be the first
        // anyone hears of it. Allowing is still right - an administrator asked for this explicitly,
        // and refusing every raise because a file could not be read would be a read failure
        // masquerading as a policy.
        this.logger.warn(
          `minClientVersion set to ${wanted} WITHOUT the deployed-version bound - package.json ` +
            `could not be read, so nothing verified that a client able to satisfy it exists`
        );
      } else if (compareSemver(wanted, deployed) > 0) {
        throw new BadRequestException(
          `minClientVersion ${wanted} is above this server's own version ${deployed}: no client ` +
            `that can satisfy it has been built, so every client would be locked out.`
        );
      }
      // THE RAISE ITSELF IS WORTH A LINE, and it used to share a `debug` with the payment provider.
      // Every client's access turns on this value; a change to it should not need log level tuning
      // to be found afterwards.
      if (wanted !== row.minClientVersion) {
        this.logger.warn(
          `minClientVersion ${row.minClientVersion} -> ${wanted} (deployed ${deployed ?? 'unknown'})`
        );
      }
      row.minClientVersion = wanted;
    }
    if (dto.paymentProvider !== undefined) {
      row.paymentProvider = dto.paymentProvider;
    }

    this.logger.debug(
      `Platform config updated maintenance=${row.maintenanceEnabled} minClient=${row.minClientVersion} paymentProvider=${row.paymentProvider}`
    );
    const saved = await this.repo.save(row);
    return toPublic(saved);
  }

  /** True when maintenance is on and the caller is not a global admin. */
  isAccessBlockedByMaintenance(config: PlatformConfigPublic, isGlobalAdmin: boolean): boolean {
    return config.maintenanceEnabled && !isGlobalAdmin;
  }
}

function toPublic(row: PlatformConfig): PlatformConfigPublic {
  return {
    maintenanceEnabled: row.maintenanceEnabled,
    maintenanceMessage: row.maintenanceMessage,
    minClientVersion: row.minClientVersion,
    paymentProvider: row.paymentProvider,
  };
}
