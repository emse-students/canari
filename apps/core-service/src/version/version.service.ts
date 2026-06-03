import { Injectable } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PlatformService } from '../platform/platform.service';

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
      version: readPackageVersion(),
      minClientVersion: platform.minClientVersion,
      maintenance: {
        enabled: platform.maintenanceEnabled,
        message: platform.maintenanceMessage,
      },
    };
  }
}

function readPackageVersion(): string {
  try {
    const pkgPath = join(__dirname, '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
