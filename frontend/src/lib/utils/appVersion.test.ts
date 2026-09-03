// The runtime this build was compiled for, as the native side reports it. Both detectors under
// test read it, and nothing else in this file touches either mock.
const nativeRuntime = vi.hoisted(() => ({ tauri: false, os: 'ios' }));
vi.mock('$lib/utils/openExternal', () => ({
  isTauriRuntime: () => nativeRuntime.tauri,
  openExternal: vi.fn(),
}));
vi.mock('@tauri-apps/plugin-os', () => ({ platform: () => nativeRuntime.os }));

import {
  APP_STORE_URL,
  PLAY_STORE_URL,
  buildAppVersionCheckResult,
  buildUpdateTarget,
  compareSemver,
  fetchServerAppVersionReliable,
  getClientAppVersion,
  getReleaseApkDownloadUrl,
  getReleasePageUrl,
  isAndroidTauriRuntime,
  isIosTauriRuntime,
  isMaintenanceBlockingUser,
  isMobileTauriRuntime,
  parseServerVersionInfo,
  releaseTag,
} from './appVersion';

describe('compareSemver', () => {
  it('orders versions correctly', () => {
    expect(compareSemver('0.3.4', '0.3.5')).toBeLessThan(0);
    expect(compareSemver('0.3.5', '0.3.5')).toBe(0);
    expect(compareSemver('1.0.0', '0.9.9')).toBeGreaterThan(0);
  });

  // THE ALPHA USED TO WIN AGAINST ITS OWN STABLE, and it failed in the reassuring direction.
  // `parseInt('0-alpha')` is 0, so `0.15.0-alpha.1` read as [0, 15, 0, 1] and beat `0.15.0` - a
  // tester on the pre-release would never have been offered the release they were testing for.
  it('ranks a pre-release below the stable it precedes', () => {
    expect(compareSemver('0.15.0-alpha.1', '0.15.0')).toBeLessThan(0);
    expect(compareSemver('0.15.0', '0.15.0-alpha.1')).toBeGreaterThan(0);
  });

  // The suffix used to contribute NOTHING: `-alpha.1` and `-beta.1` both reduced to a trailing 1.
  it('orders the tester channels the way the version band intends', () => {
    expect(compareSemver('0.15.0-alpha.1', '0.15.0-alpha.2')).toBeLessThan(0);
    expect(compareSemver('0.15.0-alpha.1', '0.15.0-beta.1')).toBeLessThan(0);
    expect(compareSemver('0.15.0-beta.1', '0.15.0-rc.1')).toBeLessThan(0);
  });

  it('compares numeric identifiers numerically rather than as text', () => {
    expect(compareSemver('0.15.0-alpha.9', '0.15.0-alpha.10')).toBeLessThan(0);
  });

  it('treats a shorter identifier list as the earlier one when the shared ones match', () => {
    expect(compareSemver('0.15.0-alpha', '0.15.0-alpha.1')).toBeLessThan(0);
  });

  // Semver gives build metadata no part in precedence, and `deploy-build.ts` exists so that a `+`
  // never reaches a field clients decide on in the first place.
  it('ignores build metadata', () => {
    expect(compareSemver('0.15.0+dev.abc1234', '0.15.0')).toBe(0);
  });

  it('still lets a newer core beat a pre-release of an older one', () => {
    expect(compareSemver('0.14.15', '0.15.0-alpha.1')).toBeLessThan(0);
    expect(compareSemver('0.15.1-alpha.1', '0.15.0')).toBeGreaterThan(0);
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

describe('store URLs', () => {
  it('points at the published listings, with no build-time configuration', () => {
    expect(PLAY_STORE_URL).toBe('https://play.google.com/store/apps/details?id=fr.emse.canari');
    // Geo-neutral: no /us/ segment, Apple redirects to the viewer's storefront.
    expect(APP_STORE_URL).toBe('https://apps.apple.com/app/id6793060521');
  });
});

describe('native runtime detection', () => {
  /** The user agent an iPad WKWebView actually sends - it names no Apple device at all. */
  const IPAD_WKWEBVIEW_UA =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)';

  function pretendUserAgent(ua: string) {
    Object.defineProperty(navigator, 'userAgent', { value: ua, configurable: true });
  }

  afterEach(() => {
    nativeRuntime.tauri = false;
    nativeRuntime.os = 'ios';
  });

  // The defect App Review rejected on 2026-08-30: an iPad claims to be a Mac, so the old
  // /iphone|ipad|ipod/ test on navigator.userAgent was false, the app took its web branch and
  // asked Authentik to redirect to tauri://localhost/auth/callback, which Authentik refused
  // with the "Redirect URI Error" page the reviewer photographed.
  it('calls an iPad iOS even though its user agent says Macintosh', () => {
    nativeRuntime.tauri = true;
    nativeRuntime.os = 'ios';
    pretendUserAgent(IPAD_WKWEBVIEW_UA);
    expect(isIosTauriRuntime()).toBe(true);
    expect(isMobileTauriRuntime()).toBe(true);
    expect(isAndroidTauriRuntime()).toBe(false);
  });

  it('reads Android from the native side, not from the user agent', () => {
    nativeRuntime.tauri = true;
    nativeRuntime.os = 'android';
    pretendUserAgent(IPAD_WKWEBVIEW_UA);
    expect(isAndroidTauriRuntime()).toBe(true);
    expect(isIosTauriRuntime()).toBe(false);
  });

  it('leaves a desktop build off both mobile paths', () => {
    nativeRuntime.tauri = true;
    nativeRuntime.os = 'macos';
    expect(isMobileTauriRuntime()).toBe(false);
  });

  // On the web there is no native side to ask; an iPhone browser is still not a Tauri build.
  it('is false everywhere on the web, whatever the device', () => {
    nativeRuntime.tauri = false;
    pretendUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15');
    expect(isIosTauriRuntime()).toBe(false);
    expect(isAndroidTauriRuntime()).toBe(false);
    expect(isMobileTauriRuntime()).toBe(false);
  });
});

describe('buildUpdateTarget', () => {
  const android = { android: true, ios: false, native: true };
  const ios = { android: false, ios: true, native: true };
  const desktop = { android: false, ios: false, native: true };
  const web = { android: false, ios: false, native: false };

  it('sends a Play install to the Play Store', () => {
    expect(buildUpdateTarget('1.2.3', android, 'play')).toEqual({
      kind: 'play',
      url: PLAY_STORE_URL,
    });
  });

  // The Play build and the GitHub APK carry different signatures, so a sideload CANNOT
  // install the Play version - it must keep getting the APK it can actually install.
  it('sends a sideloaded install to the matching APK, never to the Play Store', () => {
    expect(buildUpdateTarget('1.2.3', android, 'sideload')).toEqual({
      kind: 'apk',
      url: 'https://github.com/emse-students/canari/releases/download/v1.2.3/app-universal-release.apk',
    });
  });

  it('always sends iOS to the App Store, whatever the recorded source', () => {
    expect(buildUpdateTarget('1.2.3', ios, 'sideload')).toEqual({
      kind: 'appstore',
      url: APP_STORE_URL,
    });
  });

  it('sends other native builds to the release page', () => {
    expect(buildUpdateTarget('1.2.3', desktop, 'play')).toEqual({
      kind: 'releasePage',
      url: 'https://github.com/emse-students/canari/releases/tag/v1.2.3',
    });
  });

  it('reloads on the web instead of navigating anywhere', () => {
    expect(buildUpdateTarget('1.2.3', web, 'play')).toEqual({ kind: 'reload', url: '' });
  });

  it('falls back to the latest release when the target version is unknown', () => {
    expect(buildUpdateTarget(null, android, 'sideload').url).toBe(
      'https://github.com/emse-students/canari/releases/latest/download/app-universal-release.apk'
    );
  });
});
