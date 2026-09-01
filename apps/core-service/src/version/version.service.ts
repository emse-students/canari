import { Injectable } from '@nestjs/common';
import { PlatformService } from '../platform/platform.service';
import { deployedVersion } from '../platform/deployed-version';
import { deployBuild } from '../platform/deploy-build';

export type AppVersionResponse = {
  version: string;
  /**
   * Which BUILD is deployed, when the environment was given one - the commit, short. `null` in
   * production, whose version already names its content because it is built from a tag.
   *
   * DELIBERATELY NOT PART OF `version`: clients parse that field and turn it into a release tag and
   * a download URL, so a `+dev.<sha7>` suffix inside it would offer an update from a GitHub release
   * that does not exist. See `platform/deploy-build.ts`.
   */
  build: string | null;
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
      build: deployBuild(),
      minClientVersion: platform.minClientVersion,
      maintenance: {
        enabled: platform.maintenanceEnabled,
        message: platform.maintenanceMessage,
      },
    };
  }
}
