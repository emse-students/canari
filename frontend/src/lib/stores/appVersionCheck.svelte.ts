import {
  buildAppVersionCheckResult,
  fetchServerAppVersionReliable,
  isMaintenanceBlockingUser,
  parseServerVersionInfo,
  type AppVersionCheckResult,
} from '$lib/utils/appVersion';

const CACHED_SERVER_VERSION_KEY = 'canari:last_server_version_info';

let lastCheck = $state<AppVersionCheckResult | null>(null);
let updatePromptDismissed = $state(false);
let inflight: Promise<AppVersionCheckResult> | null = null;

function loadCachedServerInfo(): ReturnType<typeof parseServerVersionInfo> {
  if (typeof sessionStorage === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem(CACHED_SERVER_VERSION_KEY)?.trim();
    if (!raw) return null;
    return parseServerVersionInfo(JSON.parse(raw));
  } catch {
    return null;
  }
}

function saveCachedServerInfo(info: NonNullable<ReturnType<typeof parseServerVersionInfo>>): void {
  if (typeof sessionStorage === 'undefined') return;
  try {
    sessionStorage.setItem(CACHED_SERVER_VERSION_KEY, JSON.stringify(info));
  } catch {
    /* quota / private mode */
  }
}

/** Applies cached server metadata so gates can show before the network round-trip. */
function hydrateFromCachedServerInfo(): void {
  const cached = loadCachedServerInfo();
  if (!cached) return;
  const result = buildAppVersionCheckResult(cached);
  if (!result.upToDate || result.belowMinVersion || result.maintenance.enabled) {
    lastCheck = result;
  }
}

/** Latest version check result, or null before the first run. */
export function getAppVersionCheck(): AppVersionCheckResult | null {
  return lastCheck;
}

/** True when the server reports a newer optional build than this client. */
export function isAppUpdateAvailable(): boolean {
  return (
    lastCheck !== null &&
    !lastCheck.upToDate &&
    !lastCheck.belowMinVersion &&
    !updatePromptDismissed
  );
}

/** True when the client is below the server-enforced minimum version. */
export function isBelowMinClientVersion(): boolean {
  return lastCheck?.belowMinVersion === true;
}

/** True when maintenance mode blocks the current user (non-global-admin). */
export function isMaintenanceBlockingCurrentUser(isGlobalAdmin: boolean): boolean {
  if (!lastCheck) return false;
  return isMaintenanceBlockingUser(lastCheck.maintenance, isGlobalAdmin);
}

/** Blocks MLS unlock (PIN/biometric) when min version or maintenance applies. */
export function shouldBlockSessionUnlock(isGlobalAdmin: boolean): boolean {
  if (isBelowMinClientVersion()) return true;
  return isMaintenanceBlockingCurrentUser(isGlobalAdmin);
}

/** Hides the optional update modal until the next version check (e.g. on window focus). */
export function dismissAppUpdatePrompt(): void {
  updatePromptDismissed = true;
}

/**
 * Calls `GET /api/version` and updates {@link getAppVersionCheck}.
 * Dedupes concurrent calls; retries on failure; uses cached metadata for instant UI.
 */
export async function refreshAppVersionCheck(): Promise<AppVersionCheckResult> {
  if (inflight) return inflight;

  const previousServer = lastCheck?.serverVersion ?? null;

  inflight = (async () => {
    try {
      const live = await fetchServerAppVersionReliable();
      const cached = loadCachedServerInfo();
      const serverInfo = live ?? (cached && previousServer ? cached : cached);

      if (live) {
        saveCachedServerInfo(live);
      }

      lastCheck = buildAppVersionCheckResult(serverInfo);

      if (lastCheck.upToDate || serverInfo?.version !== previousServer) {
        updatePromptDismissed = false;
      }

      return lastCheck;
    } catch {
      const fallback = buildAppVersionCheckResult(loadCachedServerInfo());
      if (!fallback.upToDate || fallback.belowMinVersion || fallback.maintenance.enabled) {
        lastCheck = fallback;
      }
      return lastCheck ?? fallback;
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

if (typeof window !== 'undefined') {
  hydrateFromCachedServerInfo();
  void refreshAppVersionCheck();
}
