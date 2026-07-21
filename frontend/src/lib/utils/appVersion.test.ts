import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  buildAppVersionCheckResult,
  compareSemver,
  fetchServerAppVersionReliable,
  getClientAppVersion,
  getIosAppStoreUrl,
  getReleaseApkDownloadUrl,
  getReleasePageUrl,
  isMaintenanceBlockingUser,
  parseServerVersionInfo,
  releaseTag,
} from './appVersion';

describe('compareSemver', () => {
  it('orders versions correctly', () => {
    expect(compareSemver('0.3.4', '0.3.5')).toBeLessThan(0);
    expect(compareSemver('0.3.5', '0.3.5')).toBe(0);
    expect(compareSemver('1.0.0', '0.9.9')).toBeGreaterThan(0);
  });
});

describe('parseServerVersionInfo', () => {
  it('normalizes maintenance and min client version', () => {
    expect(
      parseServerVersionInfo({
        version: '1.2.3',
        minClientVersion: '1.0.0',
        maintenance: { enabled: true, message: ' Pause ' },
      })
    ).toEqual({
      version: '1.2.3',
      minClientVersion: '1.0.0',
      maintenance: { enabled: true, message: 'Pause' },
    });
  });
});

describe('getClientAppVersion', () => {
  it('returns a non-empty semver string', () => {
    expect(getClientAppVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('buildAppVersionCheckResult', () => {
  it('marks client as outdated when server semver is newer', () => {
    const client = getClientAppVersion();
    const result = buildAppVersionCheckResult({
      version: '99.99.99',
      minClientVersion: '0.0.0',
      maintenance: { enabled: false, message: null },
    });
    expect(result.clientVersion).toBe(client);
    expect(result.serverVersion).toBe('99.99.99');
    expect(result.upToDate).toBe(false);
    expect(result.belowMinVersion).toBe(false);
  });

  it('flags belowMinVersion when client is older than minimum', () => {
    const result = buildAppVersionCheckResult({
      version: '2.0.0',
      minClientVersion: '99.99.99',
      maintenance: { enabled: false, message: null },
    });
    expect(result.belowMinVersion).toBe(true);
  });
});

describe('isMaintenanceBlockingUser', () => {
  it('blocks non-admins when maintenance is enabled', () => {
    expect(isMaintenanceBlockingUser({ enabled: true, message: null }, false)).toBe(true);
    expect(isMaintenanceBlockingUser({ enabled: true, message: null }, true)).toBe(false);
  });
});

describe('fetchServerAppVersionReliable', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('retries until a successful response', async () => {
    vi.useFakeTimers();
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            version: '1.2.3',
            minClientVersion: '1.0.0',
            maintenance: { enabled: false, message: null },
          }),
          { status: 200 }
        )
      );

    const promise = fetchServerAppVersionReliable(fetchFn);
    await vi.runAllTimersAsync();
    const info = await promise;

    expect(info).toEqual({
      version: '1.2.3',
      minClientVersion: '1.0.0',
      maintenance: { enabled: false, message: null },
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

describe('releaseTag', () => {
  it('prefixes semver with v', () => {
    expect(releaseTag('0.3.7')).toBe('v0.3.7');
    expect(releaseTag('v1.0.0')).toBe('v1.0.0');
  });
});

describe('getReleaseApkDownloadUrl', () => {
  it('builds a direct download URL for a tagged release', () => {
    expect(getReleaseApkDownloadUrl('0.3.7')).toBe(
      'https://github.com/emse-students/canari/releases/download/v0.3.7/app-universal-release.apk'
    );
  });

  it('accepts a leading v', () => {
    expect(getReleaseApkDownloadUrl('v1.0.0')).toBe(
      'https://github.com/emse-students/canari/releases/download/v1.0.0/app-universal-release.apk'
    );
  });

  it('falls back to latest when version is missing', () => {
    expect(getReleaseApkDownloadUrl(null)).toBe(
      'https://github.com/emse-students/canari/releases/latest/download/app-universal-release.apk'
    );
  });
});

describe('getReleasePageUrl', () => {
  it('builds a tag URL for semver', () => {
    expect(getReleasePageUrl('0.3.6')).toBe(
      'https://github.com/emse-students/canari/releases/tag/v0.3.6'
    );
  });

  it('accepts a leading v', () => {
    expect(getReleasePageUrl('v1.0.0')).toBe(
      'https://github.com/emse-students/canari/releases/tag/v1.0.0'
    );
  });

  it('falls back to latest when version is missing', () => {
    expect(getReleasePageUrl(null)).toBe('https://github.com/emse-students/canari/releases/latest');
  });
});

describe('getIosAppStoreUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns an empty string when VITE_IOS_APP_STORE_URL is unset', () => {
    vi.stubEnv('VITE_IOS_APP_STORE_URL', '');
    expect(getIosAppStoreUrl()).toBe('');
  });

  it('returns the trimmed injected App Store URL', () => {
    vi.stubEnv('VITE_IOS_APP_STORE_URL', '  itms-apps://apps.apple.com/app/id123456789  ');
    expect(getIosAppStoreUrl()).toBe('itms-apps://apps.apple.com/app/id123456789');
  });
});
