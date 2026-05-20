import { coreUrl } from '$lib/utils/apiUrl';
import { openExternal } from '$lib/utils/openExternal';

/** GitHub repository where release artifacts (AppImage, APK) are published. */
export const CANARI_RELEASES_REPO = 'emse-students/canari';

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

/**
 * URL of the GitHub release page for a given semver (tag `vX.Y.Z`).
 * Falls back to `/releases/latest` when version is unknown.
 */
export function getReleasePageUrl(version: string | null): string {
  const base = `https://github.com/${CANARI_RELEASES_REPO}/releases`;
  const trimmed = version?.trim();
  if (!trimmed) return `${base}/latest`;
  const tag = trimmed.startsWith('v') ? trimmed : `v${trimmed}`;
  return `${base}/tag/${tag}`;
}

/**
 * Opens the latest release download page (Tauri / mobile) or reloads the web app
 * so the browser fetches the deployed bundle matching the server version.
 */
export async function openLatestAppUpdate(serverVersion: string | null): Promise<void> {
  const url = getReleasePageUrl(serverVersion);
  try {
    const { isTauri } = await import('@tauri-apps/api/core');
    if (isTauri()) {
      await openExternal(url);
      return;
    }
  } catch {
    /* not in Tauri */
  }
  window.location.reload();
}
