import { coreUrl } from '$lib/utils/apiUrl';
import { isTauriRuntime, openExternal } from '$lib/utils/openExternal';

/** GitHub repository where release artifacts (AppImage, APK) are published. */
export const CANARI_RELEASES_REPO = 'emse-students/canari';

/** Universal APK asset name on GitHub Releases (Android). */
export const CANARI_RELEASE_APK_FILENAME = 'app-universal-release.apk';

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
 * Falls back to `/releases/latest/download/...` when version is unknown.
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

/**
 * URL opened when the user accepts an app update prompt.
 * Android Tauri: direct APK download; other native: release tag page; web: n/a (reload).
 */
export function getAppUpdateUrl(serverVersion: string | null): string {
  if (isAndroidTauriRuntime()) {
    return getReleaseApkDownloadUrl(serverVersion);
  }
  return getReleasePageUrl(serverVersion);
}

/**
 * Opens the update target (APK download on Android, release page on desktop Tauri)
 * or reloads the web app so the browser fetches the deployed bundle.
 */
export async function openLatestAppUpdate(serverVersion: string | null): Promise<void> {
  try {
    const { isTauri } = await import('@tauri-apps/api/core');
    if (isTauri()) {
      await openExternal(getAppUpdateUrl(serverVersion));
      return;
    }
  } catch {
    /* not in Tauri */
  }
  window.location.reload();
}
