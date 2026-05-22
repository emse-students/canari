import { Injectable } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type AppVersionResponse = {
  version: string;
};

/** Resolves the deployed app version from this service's package.json (copied into the image at /app). */
@Injectable()
export class VersionService {
  /** Returns server version metadata (no authentication required). */
  getVersion(): AppVersionResponse {
    return { version: readPackageVersion() };
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
