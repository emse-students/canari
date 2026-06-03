import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PlatformConfig } from './entities/platform-config.entity';
import { UpdatePlatformConfigDto } from './dto/update-platform-config.dto';

export type PlatformConfigPublic = {
  maintenanceEnabled: boolean;
  maintenanceMessage: string | null;
  minClientVersion: string;
};

const DEFAULT_ROW: PlatformConfig = {
  id: 1,
  maintenanceEnabled: false,
  maintenanceMessage: null,
  minClientVersion: '0.0.0',
};

/** Reads and updates the singleton platform configuration row in PostgreSQL. */
@Injectable()
export class PlatformService implements OnModuleInit {
  private readonly logger = new Logger(PlatformService.name);

  constructor(
    @InjectRepository(PlatformConfig)
    private readonly repo: Repository<PlatformConfig>,
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
  async updateConfig(
    dto: UpdatePlatformConfigDto,
  ): Promise<PlatformConfigPublic> {
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
      row.minClientVersion = dto.minClientVersion.trim();
    }

    this.logger.debug(
      `Platform config updated maintenance=${row.maintenanceEnabled} minClient=${row.minClientVersion}`,
    );
    const saved = await this.repo.save(row);
    return toPublic(saved);
  }

  /** True when maintenance is on and the caller is not a global admin. */
  isAccessBlockedByMaintenance(
    config: PlatformConfigPublic,
    isGlobalAdmin: boolean,
  ): boolean {
    return config.maintenanceEnabled && !isGlobalAdmin;
  }
}

function toPublic(row: PlatformConfig): PlatformConfigPublic {
  return {
    maintenanceEnabled: row.maintenanceEnabled,
    maintenanceMessage: row.maintenanceMessage,
    minClientVersion: row.minClientVersion,
  };
}
