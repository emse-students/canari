import { Injectable } from '@nestjs/common';
import { PlatformService } from '../platform/platform.service';
import { deployedVersion } from '../platform/deployed-version';

export type AppVersionResponse = {
  version: string;
  minClientVersion: string;
  maintenance: {
    enabled: boolean;
    message: string | null;
  };
};

/** Resolves deployed app version and platform gates from core-service. */
@Injectable()
export class VersionService {
  constructor(private readonly platformService: PlatformService) {}

  /** Returns server version metadata and platform gates (no authentication required). */
  async getVersion(): Promise<AppVersionResponse> {
    const platform = await this.platformService.getConfig();
    return {
      // REPORTING, NOT DECIDING - so an unreadable version keeps its harmless default here.
      version: deployedVersion() ?? '0.0.0',
      minClientVersion: platform.minClientVersion,
      maintenance: {
        enabled: platform.maintenanceEnabled,
        message: platform.maintenanceMessage,
      },
    };
  }
}
