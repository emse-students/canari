import { VersionService } from './version.service';
import type { PlatformService } from '../platform/platform.service';

/**
 * The build identity is REPORTED beside the version, never folded into it.
 *
 * That separation is the whole subject of this file. The plan for the dev environment first
 * described the suffix as going into `/api/version`'s `version` field, and the frontend DECIDES on
 * that field: `compareSemver` parses it, `releaseTag` turns it into `vX.Y.Z`, and
 * `getReleaseApkDownloadUrl` builds a GitHub download URL from it. A `version` of
 * `0.14.15+dev.abc1234` would therefore have offered dev clients an update from the tag
 * `v0.14.15+dev.abc1234`, which is a 404.
 */
describe('VersionService', () => {
  const platform = {
    getConfig: jest.fn().mockResolvedValue({
      minClientVersion: '0.14.0',
      maintenanceEnabled: false,
      maintenanceMessage: null,
    }),
  } as unknown as PlatformService;

  const service = new VersionService(platform);

  afterEach(() => {
    delete process.env.DEPLOY_BUILD;
  });

  it('reports no build when the environment was not given one', async () => {
    delete process.env.DEPLOY_BUILD;

    const out = await service.getVersion();

    expect(out.build).toBeNull();
  });

  it('reports the build the deployment was given, without touching the version', async () => {
    process.env.DEPLOY_BUILD = 'dev.abc1234';

    const out = await service.getVersion();

    expect(out.build).toBe('dev.abc1234');
    // The version must stay a bare semver: anything appended to it becomes a release tag downstream.
    expect(out.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(out.version).not.toContain('dev');
  });

  it('treats a blank build as absent rather than reporting an empty string', async () => {
    process.env.DEPLOY_BUILD = '   ';

    const out = await service.getVersion();

    expect(out.build).toBeNull();
  });
});
