import {
  buildAppVersionCheckResult,
  fetchServerAppVersionReliable,
  type AppVersionCheckResult,
} from '$lib/utils/appVersion';

const CACHED_SERVER_VERSION_KEY = 'canari:last_server_version';

let lastCheck = $state<AppVersionCheckResult | null>(null);
let checking = $state(false);
let updatePromptDismissed = $state(false);
let inflight: Promise<AppVersionCheckResult> | null = null;

function loadCachedServerVersion(): string | null {
  if (typeof sessionStorage === 'undefined') return null;
  try {
    const v = sessionStorage.getItem(CACHED_SERVER_VERSION_KEY)?.trim();
    return v || null;
  } catch {
    return null;
  }
}

function saveCachedServerVersion(version: string): void {
  if (typeof sessionStorage === 'undefined') return;
  try {
    sessionStorage.setItem(CACHED_SERVER_VERSION_KEY, version);
  } catch {
    /* quota / private mode */
  }
}

/** Applies cached server semver so the update prompt can show before the network round-trip. */
function hydrateFromCachedServerVersion(): void {
  const cached = loadCachedServerVersion();
  if (!cached) return;
  const result = buildAppVersionCheckResult(cached);
  if (!result.upToDate) {
    lastCheck = result;
  }
}

/** Latest version check result, or null before the first run. */
export function getAppVersionCheck(): AppVersionCheckResult | null {
  return lastCheck;
}

/** True when the server reports a newer build than this client. */
export function isAppUpdateAvailable(): boolean {
  return lastCheck !== null && !lastCheck.upToDate && !updatePromptDismissed;
}

/** Hides the update modal until the next version check (e.g. on window focus). */
export function dismissAppUpdatePrompt(): void {
  updatePromptDismissed = true;
}

/**
 * Calls `GET /api/version` and updates {@link getAppVersionCheck}.
 * Dedupes concurrent calls; retries on failure; uses cached semver for instant UI.
 */
export async function refreshAppVersionCheck(): Promise<AppVersionCheckResult> {
  if (inflight) return inflight;

  const previousServer = lastCheck?.serverVersion ?? null;
  checking = true;

  inflight = (async () => {
    try {
      const live = await fetchServerAppVersionReliable();
      const serverVersion = live?.version ?? previousServer ?? loadCachedServerVersion() ?? null;

      if (live?.version) {
        saveCachedServerVersion(live.version);
      }

      lastCheck = buildAppVersionCheckResult(serverVersion);

      if (lastCheck.upToDate || serverVersion !== previousServer) {
        updatePromptDismissed = false;
      }

      return lastCheck;
    } catch {
      const fallback = buildAppVersionCheckResult(
        previousServer ?? loadCachedServerVersion() ?? null
      );
      if (!fallback.upToDate) {
        lastCheck = fallback;
      }
      return lastCheck ?? fallback;
    } finally {
      checking = false;
      inflight = null;
    }
  })();

  return inflight;
}

if (typeof window !== 'undefined') {
  hydrateFromCachedServerVersion();
  void refreshAppVersionCheck();
}
