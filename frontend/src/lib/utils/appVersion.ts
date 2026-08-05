import { coreUrl } from '$lib/utils/apiUrl';
import { isTauriRuntime, openExternal } from '$lib/utils/openExternal';

/** GitHub repository where release artifacts (AppImage, APK) are published. */
export const CANARI_RELEASES_REPO = 'emse-students/canari';

/** Universal APK asset name on GitHub Releases (Android). */
export const CANARI_RELEASE_APK_FILENAME = 'app-universal-release.apk';

/**
 * Google Play listing URL for the Android build.
 *
 * A public, permanent URL - deliberately a constant rather than build-time config, so
 * an unset variable can never mean "update path silently dead". The `https://` form is
 * used over `market://details?id=...` because the Play Store app intercepts it on
 * device, it stays valid in a desktop browser, and it needs no `opener` ACL change.
 */
export const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=fr.emse.canari';

/**
 * App Store listing URL for the iOS build.
 *
 * Geo-neutral on purpose (no `/us/` path segment): Apple redirects to the viewer's own
 * regional storefront. iOS updates always go through the App Store - there is no
 * sideloadable binary like the Android APK or the desktop AppImage - so this is the
 * only meaningful update target on iOS.
 */
export const APP_STORE_URL = 'https://apps.apple.com/app/id6793060521';

/** Play Store package name of the Google Play installer itself. */
const PLAY_STORE_INSTALLER_PACKAGE = 'com.android.vending';

export type PlatformMaintenanceInfo = {
  enabled: boolean;
  message: string | null;
};

export type ServerVersionInfo = {
  version: string;
  minClientVersion: string;
  maintenance: PlatformMaintenanceInfo;
};

export type AppVersionCheckResult = {
  clientVersion: string;
  serverVersion: string | null;
  minClientVersion: string | null;
  upToDate: boolean;
  /** True when the client is older than the server-enforced minimum. */
  belowMinVersion: boolean;
  maintenance: PlatformMaintenanceInfo;
};

const DEFAULT_MAINTENANCE: PlatformMaintenanceInfo = { enabled: false, message: null };

function normalizeMaintenance(raw: unknown): PlatformMaintenanceInfo {
  if (!raw || typeof raw !== 'object') return DEFAULT_MAINTENANCE;
  const obj = raw as { enabled?: unknown; message?: unknown };
  return {
    enabled: obj.enabled === true,
    message: typeof obj.message === 'string' && obj.message.trim() ? obj.message.trim() : null,
  };
}

/** Parses `/api/version` JSON into a normalized {@link ServerVersionInfo}. */
export function parseServerVersionInfo(data: unknown): ServerVersionInfo | null {
  if (!data || typeof data !== 'object') return null;
  const obj = data as { version?: unknown; minClientVersion?: unknown; maintenance?: unknown };
  const version = typeof obj.version === 'string' ? obj.version.trim() : '';
  if (!version) return null;
  const minRaw = typeof obj.minClientVersion === 'string' ? obj.minClientVersion.trim() : '';
  return {
    version,
    minClientVersion: minRaw || '0.0.0',
    maintenance: normalizeMaintenance(obj.maintenance),
  };
}
export function getClientAppVersion(): string {
  const v = import.meta.env.VITE_APP_VERSION?.trim();
  return v || '0.0.0';
}

/**
 * Compares two `major.minor.patch` strings.
 * @returns negative if a < b, positive if a > b, else 0
 */
export function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length, 3);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

const VERSION_FETCH_TIMEOUT_MS = 8_000;
const VERSION_FETCH_RETRIES = 3;
const VERSION_RETRY_DELAY_MS = 1_200;

/** Fetches `GET /api/version` (no auth). */
export async function fetchServerAppVersion(
  fetchFn: typeof fetch = fetch,
  signal?: AbortSignal
): Promise<ServerVersionInfo | null> {
  try {
    const res = await fetchFn(`${coreUrl()}/api/version`, {
      method: 'GET',
      cache: 'no-store',
      signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as unknown;
    return parseServerVersionInfo(data);
  } catch {
    return null;
  }
}

/** Retries `/api/version` with per-attempt timeout (mobile cold start / slow networks). */
export async function fetchServerAppVersionReliable(
  fetchFn: typeof fetch = fetch
): Promise<ServerVersionInfo | null> {
  for (let attempt = 0; attempt < VERSION_FETCH_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), VERSION_FETCH_TIMEOUT_MS);
    try {
      const info = await fetchServerAppVersion(fetchFn, controller.signal);
      if (info) return info;
    } catch {
      /* timeout or network - retry */
    } finally {
      clearTimeout(timer);
    }
    if (attempt < VERSION_FETCH_RETRIES - 1) {
      await new Promise((resolve) => setTimeout(resolve, VERSION_RETRY_DELAY_MS));
    }
  }
  return null;
}

/** Builds a version check result from server metadata (or null fields when unknown). */
export function buildAppVersionCheckResult(
  serverInfo: ServerVersionInfo | null
): AppVersionCheckResult {
  const clientVersion = getClientAppVersion();
  const serverVersion = serverInfo?.version ?? null;
  const minClientVersion = serverInfo?.minClientVersion ?? null;
  const maintenance = serverInfo?.maintenance ?? DEFAULT_MAINTENANCE;
  const upToDate = serverVersion === null || compareSemver(clientVersion, serverVersion) >= 0;
  const belowMinVersion =
    minClientVersion !== null && compareSemver(clientVersion, minClientVersion) < 0;
  return {
    clientVersion,
    serverVersion,
    minClientVersion,
    upToDate,
    belowMinVersion,
    maintenance,
  };
}

/**
 * Returns whether the running client is at least as new as the server deployment.
 * `upToDate` is true when the server version is unknown (offline) or client >= server.
 */
export async function checkAppVersion(
  fetchFn: typeof fetch = fetch
): Promise<AppVersionCheckResult> {
  const server = await fetchServerAppVersionReliable(fetchFn);
  return buildAppVersionCheckResult(server);
}

/** True when maintenance is active and the caller is not a global admin. */
export function isMaintenanceBlockingUser(
  maintenance: PlatformMaintenanceInfo,
  isGlobalAdmin: boolean
): boolean {
  return maintenance.enabled && !isGlobalAdmin;
}

/** Normalizes a semver string to a GitHub release tag (`vX.Y.Z`). */
export function releaseTag(version: string): string {
  const trimmed = version.trim();
  return trimmed.startsWith('v') ? trimmed : `v${trimmed}`;
}

/**
 * Direct APK download URL for a release (`/releases/download/vX.Y.Z/app-universal-release.apk`).
 * Falls back to `/releases/latest/download/…` when version is unknown.
 */
export function getReleaseApkDownloadUrl(version: string | null): string {
  const base = `https://github.com/${CANARI_RELEASES_REPO}/releases`;
  const trimmed = version?.trim();
  if (!trimmed) {
    return `${base}/latest/download/${CANARI_RELEASE_APK_FILENAME}`;
  }
  return `${base}/download/${releaseTag(trimmed)}/${CANARI_RELEASE_APK_FILENAME}`;
}

/**
 * URL of the GitHub release page for a given semver (tag `vX.Y.Z`).
 * Falls back to `/releases/latest` when version is unknown.
 */
export function getReleasePageUrl(version: string | null): string {
  const base = `https://github.com/${CANARI_RELEASES_REPO}/releases`;
  const trimmed = version?.trim();
  if (!trimmed) return `${base}/latest`;
  return `${base}/tag/${releaseTag(trimmed)}`;
}

/** True on Tauri Android builds (universal APK update flow). */
export function isAndroidTauriRuntime(): boolean {
  return (
    isTauriRuntime() && typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent)
  );
}

/** True on Tauri iOS builds (App Store update flow, no direct binary download). */
export function isIosTauriRuntime(): boolean {
  return (
    isTauriRuntime() &&
    typeof navigator !== 'undefined' &&
    /iphone|ipad|ipod/i.test(navigator.userAgent)
  );
}

/**
 * True on any native mobile Tauri build (Android or iOS). Use this for logic that
 * must run wherever a native background engine advances `mls.bin` and posts its own
 * OS notifications - both platforms do (Android via CanariFirebaseMessagingService,
 * iOS via canari_push.mm) - as opposed to Android-only APK/update concerns.
 */
export function isMobileTauriRuntime(): boolean {
  return isAndroidTauriRuntime() || isIosTauriRuntime();
}

/**
 * How this Android install arrived, which decides where its updates can come from.
 *
 * The Play build is signed by Google Play App Signing; the GitHub `app-universal-release.apk`
 * is signed with our upload key. The two signatures differ, so NEITHER build can install
 * over the other - sending a sideload user to the Play Store hands them an install Android
 * will refuse. The target is therefore a runtime fact, never a build-time constant.
 */
export type AndroidInstallSource = 'play' | 'sideload';

/** Where an update prompt sends the user, and which wording that target needs. */
export type UpdateTargetKind = 'play' | 'appstore' | 'apk' | 'releasePage' | 'reload';

export type UpdateTarget = {
  kind: UpdateTargetKind;
  /** Empty for `reload`, which is a `window.location.reload()` rather than a navigation. */
  url: string;
};

/** Runtime platform facts {@link buildUpdateTarget} decides from. Injectable for tests. */
export type UpdatePlatform = {
  android: boolean;
  ios: boolean;
  native: boolean;
};

/** Reads the current runtime into an {@link UpdatePlatform}. */
export function currentUpdatePlatform(): UpdatePlatform {
  return {
    android: isAndroidTauriRuntime(),
    ios: isIosTauriRuntime(),
    native: isTauriRuntime(),
  };
}

/**
 * Pure mapping from platform + install source to an update destination.
 *
 * Split from the probe below so the decision itself is unit-testable without a Tauri
 * runtime: Android goes to Play or to the matching APK depending on how it was installed,
 * iOS always to the App Store, other native builds to the GitHub release page, and the
 * web to a plain reload (the browser then fetches the deployed bundle).
 */
export function buildUpdateTarget(
  serverVersion: string | null,
  platform: UpdatePlatform,
  installSource: AndroidInstallSource
): UpdateTarget {
  if (platform.android) {
    return installSource === 'play'
      ? { kind: 'play', url: PLAY_STORE_URL }
      : { kind: 'apk', url: getReleaseApkDownloadUrl(serverVersion) };
  }
  if (platform.ios) {
    return { kind: 'appstore', url: APP_STORE_URL };
  }
  if (platform.native) {
    return { kind: 'releasePage', url: getReleasePageUrl(serverVersion) };
  }
  return { kind: 'reload', url: '' };
}

/** Memoized: the install source cannot change while the process lives. */
let installSourceProbe: Promise<AndroidInstallSource> | null = null;

/**
 * Asks the native side which package installed this app (`installer_package.txt`, written
 * by `CanariApplication.onCreate`) and maps it to an {@link AndroidInstallSource}.
 *
 * Defaults to `'play'` when the probe fails AND LOGS IT: every build carrying this code
 * writes that file at startup, so a miss is a real fault rather than an expected state,
 * and Play is the correct assumption for every install made from now on.
 */
export async function probeAndroidInstallSource(): Promise<AndroidInstallSource> {
  installSourceProbe ??= (async (): Promise<AndroidInstallSource> => {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const installer = (await invoke<string | null>('get_installer_package'))?.trim();
      if (!installer) {
        console.warn(
          '[appVersion] installer package unknown (empty or missing installer_package.txt) - assuming Play Store'
        );
        return 'play';
      }
      console.debug(`[appVersion] install source: ${installer}`);
      return installer === PLAY_STORE_INSTALLER_PACKAGE ? 'play' : 'sideload';
    } catch (e) {
      console.warn('[appVersion] get_installer_package failed - assuming Play Store:', e);
      return 'play';
    }
  })();
  return installSourceProbe;
}

/**
 * Resolves where this specific install must be sent to update. Probes the Android install
 * source; every other platform has a single possible target, so it skips the round trip.
 */
export async function resolveUpdateTarget(serverVersion: string | null): Promise<UpdateTarget> {
  const platform = currentUpdatePlatform();
  const installSource = platform.android ? await probeAndroidInstallSource() : 'play';
  return buildUpdateTarget(serverVersion, platform, installSource);
}

/**
 * Opens the resolved update target (Play Store or matching APK on Android, App Store on
 * iOS, release page on desktop Tauri), or reloads the web app so the browser fetches the
 * deployed bundle.
 */
export async function openLatestAppUpdate(serverVersion: string | null): Promise<void> {
  const target = await resolveUpdateTarget(serverVersion);
  if (target.kind === 'reload') {
    window.location.reload();
    return;
  }
  await openExternal(target.url);
}
