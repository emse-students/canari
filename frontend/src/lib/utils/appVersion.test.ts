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
  serverVersionInfoToWire,
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
      callsMode: 'off',
      groupCallsMode: 'off',
      callRelay: 'none',
      livesMode: 'off',
      liveReplaysMode: 'off',
      checkpointSkipMode: 'off',
      oidcPkce: false,
      presencePost: false,
      publishQueue: false,
      formDrafts: false,
      gridRequiredSwitch: false,
      rankedFeeds: false,
      formAnswerEdit: false,
      eventReach: false,
      retention: null,
    });
  });

  it('reads the PKCE capability, and an absent or non-true field as none', () => {
    expect(parseServerVersionInfo({ version: '1.2.3', oidcPkce: true })?.oidcPkce).toBe(true);
    expect(parseServerVersionInfo({ version: '1.2.3' })?.oidcPkce).toBe(false);
    expect(parseServerVersionInfo({ version: '1.2.3', oidcPkce: 'true' })?.oidcPkce).toBe(false);
  });

  it('reads the presence POST capability, and an absent or non-true field as none', () => {
    expect(parseServerVersionInfo({ version: '1.2.3', presencePost: true })?.presencePost).toBe(
      true
    );
    expect(parseServerVersionInfo({ version: '1.2.3' })?.presencePost).toBe(false);
    expect(parseServerVersionInfo({ version: '1.2.3', presencePost: 1 })?.presencePost).toBe(false);
  });

  it('reads the publish queue capability, absent or non-true as none, and stores it round-trip', () => {
    const info = parseServerVersionInfo({ version: '1.2.3', publishQueue: true });
    expect(info?.publishQueue).toBe(true);
    expect(parseServerVersionInfo(serverVersionInfoToWire(info!))?.publishQueue).toBe(true);
    expect(parseServerVersionInfo({ version: '1.2.3' })?.publishQueue).toBe(false);
    expect(parseServerVersionInfo({ version: '1.2.3', publishQueue: 'yes' })?.publishQueue).toBe(
      false
    );
  });

  it('reads the form drafts capability, absent or non-true as none, and stores it round-trip', () => {
    const info = parseServerVersionInfo({ version: '1.2.3', formDrafts: true });
    expect(info?.formDrafts).toBe(true);
    expect(parseServerVersionInfo(serverVersionInfoToWire(info!))?.formDrafts).toBe(true);
    expect(parseServerVersionInfo({ version: '1.2.3' })?.formDrafts).toBe(false);
    expect(parseServerVersionInfo({ version: '1.2.3', formDrafts: 1 })?.formDrafts).toBe(false);
    // Each priced grid's own switch: the same rule, `true` only, kept through the cache.
    const grid = parseServerVersionInfo({ version: '1.2.3', gridRequiredSwitch: true });
    expect(grid?.gridRequiredSwitch).toBe(true);
    expect(parseServerVersionInfo(serverVersionInfoToWire(grid!))?.gridRequiredSwitch).toBe(true);
    expect(parseServerVersionInfo({ version: '1.2.3' })?.gridRequiredSwitch).toBe(false);
    expect(
      parseServerVersionInfo({ version: '1.2.3', gridRequiredSwitch: 'yes' })?.gridRequiredSwitch
    ).toBe(false);
    const ranked = parseServerVersionInfo({ version: '1.6.9', rankedFeeds: true });
    expect(ranked?.rankedFeeds).toBe(true);
    expect(parseServerVersionInfo(serverVersionInfoToWire(ranked!))?.rankedFeeds).toBe(true);
    expect(parseServerVersionInfo({ version: '1.6.8' })?.rankedFeeds).toBe(false);
  });

  it('reads the answer-edit capability, absent or non-true as none, and stores it round-trip', () => {
    const info = parseServerVersionInfo({ version: '1.6.12', formAnswerEdit: true });
    expect(info?.formAnswerEdit).toBe(true);
    expect(parseServerVersionInfo(serverVersionInfoToWire(info!))?.formAnswerEdit).toBe(true);
    // 1.6.6 to 1.6.11 never sent it: the switch and "Modifier ma reponse" stay hidden there.
    expect(parseServerVersionInfo({ version: '1.6.11' })?.formAnswerEdit).toBe(false);
    expect(
      parseServerVersionInfo({ version: '1.6.12', formAnswerEdit: 'yes' })?.formAnswerEdit
    ).toBe(false);
  });

  it('reads the event reach capability, absent or non-true as none, and stores it round-trip', () => {
    const info = parseServerVersionInfo({ version: '1.6.12', eventReach: true });
    expect(info?.eventReach).toBe(true);
    expect(parseServerVersionInfo(serverVersionInfoToWire(info!))?.eventReach).toBe(true);
    expect(parseServerVersionInfo({ version: '1.6.11' })?.eventReach).toBe(false);
    expect(parseServerVersionInfo({ version: '1.6.12', eventReach: 'yes' })?.eventReach).toBe(
      false
    );
  });

  it('reads the retention durations in force, absent as null, and stores them round-trip', () => {
    const retention = { reelDays: 180, liveReplayDays: 5, chatReelDays: 14, idleMediaDays: 60 };
    const info = parseServerVersionInfo({ version: '1.6.13', retention });
    expect(info?.retention).toEqual(retention);
    expect(parseServerVersionInfo(serverVersionInfoToWire(info!))?.retention).toEqual(retention);
    expect(parseServerVersionInfo({ version: '1.6.12' })?.retention).toBeNull();
  });

  it('stores the presence POST capability in the shape it is read back with', () => {
    const info = parseServerVersionInfo({ version: '1.2.3', presencePost: true });
    expect(info).not.toBeNull();
    expect(parseServerVersionInfo(serverVersionInfoToWire(info!))?.presencePost).toBe(true);
  });

  it.each(['off', 'audio', 'audio_video'] as const)('reads the calls kill switch %s', (mode) => {
    expect(parseServerVersionInfo({ version: '1.2.3', calls: { mode } })?.callsMode).toBe(mode);
  });

  it.each([
    ['absent (a server before the switch)', undefined],
    ['not an object', 'audio'],
    ['an unknown value', { mode: 'on' }],
  ])('reads calls as CLOSED when the field is %s - a kill switch fails closed', (_n, calls) => {
    expect(parseServerVersionInfo({ version: '1.2.3', calls })?.callsMode).toBe('off');
  });

  // THE SESSION CACHE STORES WHAT IT PARSES BACK. It used to store the parsed shape (`callsMode` at
  // the top) and re-parse it as a wire body (`calls.mode`), so every cached mode came back `off`.
  it.each(['off', 'audio', 'audio_video'] as const)(
    'survives the cache round trip with calls %s',
    (mode) => {
      const info = parseServerVersionInfo({
        version: '1.2.3',
        minClientVersion: '1.0.0',
        maintenance: { enabled: true, message: 'Pause' },
        calls: { mode },
      });
      expect(info).not.toBeNull();
      const cached = JSON.parse(JSON.stringify(serverVersionInfoToWire(info!))) as unknown;
      expect(parseServerVersionInfo(cached)).toEqual(info);
    }
  );

  it.each(['off', 'on'] as const)('reads the lives kill switch %s', (mode) => {
    expect(parseServerVersionInfo({ version: '1.2.3', lives: { mode } })?.livesMode).toBe(mode);
  });

  it.each([
    ['absent (a server before the switch)', undefined],
    ['not an object', 'on'],
    ['an unknown value', { mode: 'ON' }],
    ['a boolean', { mode: true }],
  ])('reads lives as CLOSED when the field is %s - a kill switch fails closed', (_n, lives) => {
    expect(parseServerVersionInfo({ version: '1.2.3', lives })?.livesMode).toBe('off');
  });

  it.each(['off', 'on'] as const)('reads the checkpoint-skip switch %s', (mode) => {
    expect(
      parseServerVersionInfo({ version: '1.2.3', checkpointSkip: { mode } })?.checkpointSkipMode
    ).toBe(mode);
  });

  it.each([
    ['absent (a server before the switch)', undefined],
    ['not an object', 'on'],
    ['an unknown value', { mode: 'ON' }],
    ['a count instead of a mode', { mode: 100 }],
  ])("reads the checkpoint skip as OFF when the field is %s - today's durability", (_n, raw) => {
    expect(
      parseServerVersionInfo({ version: '1.2.3', checkpointSkip: raw })?.checkpointSkipMode
    ).toBe('off');
  });

  it('survives the cache round trip with the checkpoint skip on', () => {
    const info = parseServerVersionInfo({ version: '1.2.3', checkpointSkip: { mode: 'on' } });
    const cached = JSON.parse(JSON.stringify(serverVersionInfoToWire(info!))) as unknown;
    expect(parseServerVersionInfo(cached)).toEqual(info);
    expect(info?.checkpointSkipMode).toBe('on');
  });

  it.each(['off', 'on'] as const)('survives the cache round trip with lives %s', (mode) => {
    const info = parseServerVersionInfo({
      version: '1.2.3',
      calls: { mode: 'audio' },
      lives: { mode },
    });
    const cached = JSON.parse(JSON.stringify(serverVersionInfoToWire(info!))) as unknown;
    expect(parseServerVersionInfo(cached)).toEqual(info);
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
      callsMode: 'audio',
      groupCallsMode: 'mesh',
      callRelay: 'none',
      livesMode: 'on',
      liveReplaysMode: 'off',
      checkpointSkipMode: 'off',
      oidcPkce: true,
      presencePost: false,
      publishQueue: false,
      formDrafts: false,
      gridRequiredSwitch: false,
      rankedFeeds: false,
      formAnswerEdit: false,
      eventReach: false,
      retention: null,
    });
    expect(result.callsMode).toBe('audio');
    expect(result.livesMode).toBe('on');
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
      callsMode: 'off',
      groupCallsMode: 'off',
      callRelay: 'none',
      livesMode: 'off',
      liveReplaysMode: 'off',
      checkpointSkipMode: 'off',
      oidcPkce: false,
      presencePost: false,
      publishQueue: false,
      formDrafts: false,
      gridRequiredSwitch: false,
      rankedFeeds: false,
      formAnswerEdit: false,
      eventReach: false,
      retention: null,
    });
    expect(result.belowMinVersion).toBe(true);
  });

  it('knows calls as closed before any server has answered', () => {
    expect(buildAppVersionCheckResult(null).callsMode).toBe('off');
  });

  it('knows lives as closed before any server has answered', () => {
    expect(buildAppVersionCheckResult(null).livesMode).toBe('off');
  });

  it('knows the checkpoint skip as off before any server has answered', () => {
    expect(buildAppVersionCheckResult(null).checkpointSkipMode).toBe('off');
  });

  it('offers no PKCE before any server has answered', () => {
    expect(buildAppVersionCheckResult(null).oidcPkce).toBe(false);
  });

  it('claims no presence POST before any server has answered', () => {
    expect(buildAppVersionCheckResult(null).presencePost).toBe(false);
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
      callsMode: 'off',
      groupCallsMode: 'off',
      callRelay: 'none',
      livesMode: 'off',
      liveReplaysMode: 'off',
      checkpointSkipMode: 'off',
      oidcPkce: false,
      presencePost: false,
      publishQueue: false,
      formDrafts: false,
      gridRequiredSwitch: false,
      rankedFeeds: false,
      formAnswerEdit: false,
      eventReach: false,
      retention: null,
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

describe('the live replays switch of /api/version', () => {
  it.each(['off', 'on'] as const)('reads %s', (mode) => {
    expect(
      parseServerVersionInfo({ version: '1.2.3', liveReplays: { mode } })?.liveReplaysMode
    ).toBe(mode);
  });
  it.each([undefined, 'on', { mode: 'ON' }, { mode: true }])(
    'reads %j as CLOSED - a switch that cannot be read fails closed',
    (raw) => {
      expect(parseServerVersionInfo({ version: '1.2.3', liveReplays: raw })?.liveReplaysMode).toBe(
        'off'
      );
    }
  );
  it('survives the cache round trip', () => {
    const info = parseServerVersionInfo({ version: '1.2.3', liveReplays: { mode: 'on' } });
    const cached = JSON.parse(JSON.stringify(serverVersionInfoToWire(info!))) as unknown;
    expect(parseServerVersionInfo(cached)).toEqual(info);
    expect(info?.liveReplaysMode).toBe('on');
  });
});

describe('the group calls switch of /api/version (calls.groupMode)', () => {
  it.each(['off', 'mesh'] as const)('reads %s', (mode) => {
    expect(
      parseServerVersionInfo({ version: '1.2.3', calls: { mode: 'audio_video', groupMode: mode } })
        ?.groupCallsMode
    ).toBe(mode);
  });
  it.each([undefined, 'mesh', { mode: 'audio' }, { groupMode: 'MESH' }, { groupMode: true }])(
    'reads %j as CLOSED - a switch that cannot be read fails closed',
    (raw) => {
      expect(parseServerVersionInfo({ version: '1.2.3', calls: raw })?.groupCallsMode).toBe('off');
    }
  );
  it('survives the cache round trip', () => {
    const info = parseServerVersionInfo({
      version: '1.2.3',
      calls: { mode: 'audio', groupMode: 'mesh' },
    });
    const cached = JSON.parse(JSON.stringify(serverVersionInfoToWire(info!))) as unknown;
    expect(parseServerVersionInfo(cached)).toEqual(info);
    expect(info?.groupCallsMode).toBe('mesh');
    expect(info?.callsMode).toBe('audio');
  });
});

describe('the call relay of /api/version (calls.relay)', () => {
  it.each(['none', 'call-service'] as const)('reads %s', (relay) => {
    expect(
      parseServerVersionInfo({
        version: '1.2.3',
        calls: { mode: 'audio', groupMode: 'mesh', relay },
      })?.callRelay
    ).toBe(relay);
  });
  it.each([undefined, 'call-service', { mode: 'audio' }, { relay: 'cloudflare' }, { relay: 1 }])(
    'reads %j as none - a server without the setting has no relay',
    (raw) => {
      expect(parseServerVersionInfo({ version: '1.2.3', calls: raw })?.callRelay).toBe('none');
    }
  );
  it('survives the cache round trip', () => {
    const info = parseServerVersionInfo({
      version: '1.2.3',
      calls: { mode: 'audio', groupMode: 'mesh', relay: 'call-service' },
    });
    const cached = JSON.parse(JSON.stringify(serverVersionInfoToWire(info!))) as unknown;
    expect(parseServerVersionInfo(cached)).toEqual(info);
    expect(info?.callRelay).toBe('call-service');
  });
});
