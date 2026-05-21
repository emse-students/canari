import { coreUrl } from '$lib/utils/apiUrl';
import { isTauriRuntime, openExternal } from '$lib/utils/openExternal';

/** GitHub repository where release artifacts (AppImage, APK) are published. */
export const CANARI_RELEASES_REPO = 'emse-students/canari';

/** Universal APK asset name on GitHub Releases (Android). */
export const CANARI_RELEASE_APK_FILENAME = 'app-universal-release.apk';

export type ServerVersionInfo = {
  version: string;
};

export type AppVersionCheckResult = {
  clientVersion: string;
  serverVersion: string | null;
  upToDate: boolean;
};

/** Semver from frontend/package.json, injected at build time via vite.config.js. */
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

/** Fetches `GET /api/version` (no auth). */
export async function fetchServerAppVersion(
  fetchFn: typeof fetch = fetch
): Promise<ServerVersionInfo | null> {
  try {
    const res = await fetchFn(`${coreUrl()}/api/version`, {
      method: 'GET',
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const data = (await res.json()) as ServerVersionInfo;
    if (!data?.version?.trim()) return null;
    return { version: data.version.trim() };
  } catch {
    return null;
  }
}

/**
 * Returns whether the running client is at least as new as the server deployment.
 * `upToDate` is true when the server version is unknown (offline) or client >= server.
 */
export async function checkAppVersion(
  fetchFn: typeof fetch = fetch
): Promise<AppVersionCheckResult> {
  const clientVersion = getClientAppVersion();
  const server = await fetchServerAppVersion(fetchFn);
  const serverVersion = server?.version ?? null;
  const upToDate = serverVersion === null || compareSemver(clientVersion, serverVersion) >= 0;

  return {
    clientVersion,
    serverVersion,
    upToDate,
  };
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
